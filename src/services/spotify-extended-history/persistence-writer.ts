import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

import type { SpotifyExtendedMusicEvent } from "./parser";
import {
  parseSpotifyExtendedPersistenceManifest,
  type SpotifyExtendedPersistenceManifest,
} from "./persistence-manifest";
import {
  persistencePlanFromActions,
  type SpotifyExtendedPersistencePlan,
} from "./persistence-plan";

const DEFAULT_BATCH_SIZE = 500;

export type ApplySpotifyExtendedHistoryOptions = {
  userId: string;
  packageSha256: string;
  expectedPackageSha256: string;
  expectedPlanHash: string;
  expectedManifestHash: string;
  manifest: SpotifyExtendedPersistenceManifest;
  musicEvents: SpotifyExtendedMusicEvent[];
  client?: PrismaClient;
  batchSize?: number;
};

export type ApplySpotifyExtendedHistoryResult = {
  runId: string;
  planHash: string;
  manifestHash: string;
  insertedEvents: number;
  enrichedEvents: number;
  duplicateEvents: number;
  noopEvents: number;
  quarantinedEvents: number;
};

/**
 * HISTORY-02 persistence writer.
 *
 * The writer executes a frozen manifest instead of rebuilding actions from the
 * current database state. That makes a partial import restartable: re-running
 * the same manifest repeats the same action list, while inserts and enrichment
 * remain idempotent at the database layer.
 *
 * A frozen INSERT_NEW is still revalidated at write time. Each batch briefly
 * acquires SHARE ROW EXCLUSIVE on TrackListeningEvent, which blocks concurrent
 * history writers (but not readers) while the guarded INSERT checks the current
 * canonical timeline. If a Last.fm/Recently Played/Extended candidate appeared
 * after the dry-run, the stale insert converges to a no-op instead of creating
 * a cross-source duplicate.
 *
 * It never calls Spotify/Last.fm, never generates playlists and never updates
 * TrackListeningState. Historical rows enrich the factual timeline only.
 */
export async function applySpotifyExtendedHistory(
  options: ApplySpotifyExtendedHistoryOptions,
): Promise<ApplySpotifyExtendedHistoryResult> {
  const client = options.client ?? defaultPrisma;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
    throw new Error("HISTORY-02 batchSize must be an integer between 1 and 2000");
  }

  const manifest = parseSpotifyExtendedPersistenceManifest(options.manifest);
  if (manifest.userId !== options.userId) {
    throw new Error("HISTORY-02 manifest user does not match the apply user");
  }
  if (options.packageSha256 !== options.expectedPackageSha256) {
    throw new Error("HISTORY-02 package SHA does not match the frozen dry-run");
  }
  if (manifest.packageSha256 !== options.packageSha256) {
    throw new Error("HISTORY-02 manifest package SHA does not match the supplied package");
  }
  if (manifest.planHash !== options.expectedPlanHash) {
    throw new Error("HISTORY-02 persistence plan hash does not match the frozen dry-run");
  }
  if (manifest.manifestHash !== options.expectedManifestHash) {
    throw new Error("HISTORY-02 manifest hash does not match the frozen dry-run");
  }

  const plan = persistencePlanFromActions(manifest.packageSha256, manifest.actions);
  if (plan.planHash !== manifest.planHash) {
    throw new Error("HISTORY-02 manifest actions no longer reproduce the frozen plan hash");
  }

  const eventBySourceKey = new Map(
    options.musicEvents.map((event) => [event.sourceEventKey, event] as const),
  );
  if (eventBySourceKey.size !== options.musicEvents.length) {
    throw new Error("HISTORY-02 package contains duplicate sourceEventKey values after parsing");
  }
  for (const action of plan.actions) {
    if (!eventBySourceKey.has(action.sourceEventKey)) {
      throw new Error(`HISTORY-02 planned sourceEventKey is missing from package: ${action.sourceEventKey}`);
    }
  }

  const runId = randomUUID();
  await createAuditRun(client, runId, options.userId, plan);

  let insertedEvents = 0;
  let enrichedEvents = 0;
  let duplicateEvents = 0;
  let noopEvents = plan.summary.noopAlreadyEnriched;

  try {
    for (let offset = 0; offset < plan.actions.length; offset += batchSize) {
      const actions = plan.actions.slice(offset, offset + batchSize);
      const insertEvents: SpotifyExtendedMusicEvent[] = [];
      const enrichEvents: { id: string; event: SpotifyExtendedMusicEvent }[] = [];

      for (const action of actions) {
        const event = eventBySourceKey.get(action.sourceEventKey)!;

        if (action.kind === "INSERT_NEW") {
          insertEvents.push(event);
          continue;
        }
        if (action.kind === "ENRICH_EXISTING") {
          if (!action.existingEventId) {
            throw new Error(`HISTORY-02 enrichment has no existing event: ${action.sourceEventKey}`);
          }
          enrichEvents.push({ id: action.existingEventId, event });
        }
      }

      const batchResult = await client.$transaction(async (tx) => {
        // Prevent a Last.fm/Recently writer from racing between our canonical
        // candidate check and INSERT. AccessShare readers remain allowed.
        await tx.$executeRawUnsafe(
          'LOCK TABLE "TrackListeningEvent" IN SHARE ROW EXCLUSIVE MODE',
        );

        const inserted = await insertNewEvents(
          tx,
          options.userId,
          options.packageSha256,
          insertEvents,
        );
        const enriched = await enrichExistingEvents(
          tx,
          options.userId,
          options.packageSha256,
          enrichEvents,
        );
        return { inserted, enriched };
      });

      insertedEvents += batchResult.inserted;
      duplicateEvents += insertEvents.length - batchResult.inserted;
      enrichedEvents += batchResult.enriched;
      noopEvents += enrichEvents.length - batchResult.enriched;

      await updateAuditProgress(client, runId, {
        insertedEvents,
        enrichedEvents,
        duplicateEvents,
        noopEvents,
      });
    }

    await finishAuditRun(client, runId, "SUCCESS", {
      insertedEvents,
      enrichedEvents,
      duplicateEvents,
      noopEvents,
      error: null,
    });

    return {
      runId,
      planHash: plan.planHash,
      manifestHash: manifest.manifestHash,
      insertedEvents,
      enrichedEvents,
      duplicateEvents,
      noopEvents,
      quarantinedEvents: plan.summary.quarantineConflict,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await finishAuditRun(client, runId, "FAILED", {
        insertedEvents,
        enrichedEvents,
        duplicateEvents,
        noopEvents,
        error: message,
      });
    } catch {
      // Preserve the original writer/database error.
    }
    throw error;
  }
}

async function insertNewEvents(
  tx: Prisma.TransactionClient,
  userId: string,
  packageSha256: string,
  events: SpotifyExtendedMusicEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const rows = events.map((event) => Prisma.sql`(
    ${randomUUID()}::text,
    ${userId}::text,
    ${event.spotifyTrackId}::text,
    ${event.spotifyTrackUri}::text,
    ${event.trackName}::text,
    ${event.artistName}::text,
    ${event.albumName}::text,
    (${event.estimatedStartedAt}::timestamptz AT TIME ZONE 'UTC'),
    ${event.sourceEventKey}::text,
    ${normalizeText(event.artistName)}::text,
    ${normalizeText(event.trackName)}::text,
    ${JSON.stringify(toExtendedMetadata(packageSha256, event))}::jsonb
  )`);

  return tx.$executeRaw(Prisma.sql`
    WITH incoming(
      "id",
      "userId",
      "spotifyTrackId",
      "spotifyUri",
      "trackName",
      "artistName",
      "albumName",
      "playedAt",
      "sourceEventKey",
      "artistKey",
      "trackKey",
      "metadata"
    ) AS (
      VALUES ${Prisma.join(rows)}
    )
    INSERT INTO "TrackListeningEvent" (
      "id",
      "userId",
      "spotifyTrackId",
      "spotifyUri",
      "trackName",
      "artistName",
      "primaryArtistId",
      "albumName",
      "albumId",
      "isrc",
      "trackMbid",
      "artistMbid",
      "albumMbid",
      "playedAt",
      "source",
      "sourceEventKey",
      "contextType",
      "contextUri",
      "metadata"
    )
    SELECT
      incoming."id",
      incoming."userId",
      incoming."spotifyTrackId",
      incoming."spotifyUri",
      incoming."trackName",
      incoming."artistName",
      NULL,
      incoming."albumName",
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      incoming."playedAt",
      'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource",
      incoming."sourceEventKey",
      NULL,
      NULL,
      incoming."metadata"
    FROM incoming
    WHERE NOT EXISTS (
      SELECT 1
      FROM "TrackListeningEvent" existing
      WHERE existing."userId" = incoming."userId"
        AND (
          (
            existing."source" = 'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource"
            AND existing."sourceEventKey" = incoming."sourceEventKey"
          )
          OR (
            existing."playedAt" BETWEEN
              incoming."playedAt" - INTERVAL '10 minutes'
              AND incoming."playedAt" + INTERVAL '10 minutes'
            AND (
              (
                existing."source" = 'SPOTIFY_RECENTLY_PLAYED'::"ListeningEventSource"
                AND existing."spotifyTrackId" = incoming."spotifyTrackId"
              )
              OR (
                existing."source" = 'LASTFM_SCROBBLE'::"ListeningEventSource"
                AND lower(regexp_replace(btrim(existing."artistName"), '[[:space:]]+', ' ', 'g')) = incoming."artistKey"
                AND lower(regexp_replace(btrim(existing."trackName"), '[[:space:]]+', ' ', 'g')) = incoming."trackKey"
              )
            )
          )
        )
    )
    ON CONFLICT ("userId", "source", "sourceEventKey") DO NOTHING
  `);
}

async function enrichExistingEvents(
  tx: Prisma.TransactionClient,
  userId: string,
  packageSha256: string,
  rowsToEnrich: { id: string; event: SpotifyExtendedMusicEvent }[],
): Promise<number> {
  if (rowsToEnrich.length === 0) return 0;

  const rows = rowsToEnrich.map(({ id, event }) => Prisma.sql`(
    ${id}::text,
    ${event.spotifyTrackId}::text,
    ${event.spotifyTrackUri}::text,
    ${event.albumName}::text,
    ${JSON.stringify(toExtendedEvidence(packageSha256, event))}::jsonb
  )`);

  return tx.$executeRaw(Prisma.sql`
    UPDATE "TrackListeningEvent" AS target
    SET
      "spotifyTrackId" = COALESCE(target."spotifyTrackId", source."spotifyTrackId"),
      "spotifyUri" = COALESCE(target."spotifyUri", source."spotifyUri"),
      "albumName" = COALESCE(target."albumName", source."albumName"),
      "metadata" = COALESCE(target."metadata", '{}'::jsonb)
        || jsonb_build_object('spotifyExtendedHistory', source."evidence")
    FROM (
      VALUES ${Prisma.join(rows)}
    ) AS source("id", "spotifyTrackId", "spotifyUri", "albumName", "evidence")
    WHERE target."id" = source."id"
      AND target."userId" = ${userId}
      AND NOT (COALESCE(target."metadata", '{}'::jsonb) ? 'spotifyExtendedHistory')
  `);
}

function toExtendedEvidence(packageSha256: string, event: SpotifyExtendedMusicEvent) {
  return {
    packageSha256,
    sourceEventKey: event.sourceEventKey,
    spotifyTrackUri: event.spotifyTrackUri,
    endedAt: event.endedAt.toISOString(),
    estimatedStartedAt: event.estimatedStartedAt.toISOString(),
    msPlayed: event.msPlayed,
    skipped: event.skipped,
    explicitSkip: event.skipped === true,
    reasonStart: event.reasonStart,
    reasonEnd: event.reasonEnd,
  };
}

function toExtendedMetadata(packageSha256: string, event: SpotifyExtendedMusicEvent) {
  return {
    spotifyExtendedHistory: toExtendedEvidence(packageSha256, event),
  };
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

async function createAuditRun(
  client: PrismaClient,
  runId: string,
  userId: string,
  plan: SpotifyExtendedPersistencePlan,
): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "SpotifyExtendedHistoryImportRun" (
      "id",
      "userId",
      "packageSha256",
      "planHash",
      "planVersion",
      "status",
      "uniqueMusicEvents",
      "insertPlanned",
      "enrichPlanned",
      "quarantinePlanned"
    ) VALUES (
      ${runId},
      ${userId},
      ${plan.packageSha256},
      ${plan.planHash},
      ${plan.version},
      'RUNNING'::"SpotifyExtendedHistoryImportStatus",
      ${plan.actions.length},
      ${plan.summary.insertNew},
      ${plan.summary.enrichExisting},
      ${plan.summary.quarantineConflict}
    )
  `);
}

async function updateAuditProgress(
  client: PrismaClient,
  runId: string,
  counts: {
    insertedEvents: number;
    enrichedEvents: number;
    duplicateEvents: number;
    noopEvents: number;
  },
): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    UPDATE "SpotifyExtendedHistoryImportRun"
    SET
      "insertedEvents" = ${counts.insertedEvents},
      "enrichedEvents" = ${counts.enrichedEvents},
      "duplicateEvents" = ${counts.duplicateEvents},
      "noopEvents" = ${counts.noopEvents}
    WHERE "id" = ${runId}
  `);
}

async function finishAuditRun(
  client: PrismaClient,
  runId: string,
  status: "SUCCESS" | "FAILED",
  input: {
    insertedEvents: number;
    enrichedEvents: number;
    duplicateEvents: number;
    noopEvents: number;
    error: string | null;
  },
): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    UPDATE "SpotifyExtendedHistoryImportRun"
    SET
      "status" = ${status}::"SpotifyExtendedHistoryImportStatus",
      "insertedEvents" = ${input.insertedEvents},
      "enrichedEvents" = ${input.enrichedEvents},
      "duplicateEvents" = ${input.duplicateEvents},
      "noopEvents" = ${input.noopEvents},
      "finishedAt" = CURRENT_TIMESTAMP,
      "error" = ${input.error}
    WHERE "id" = ${runId}
  `);
}

export async function markSpotifyExtendedHistoryRunPartial(
  client: PrismaClient,
  runId: string,
  error: string,
): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    UPDATE "SpotifyExtendedHistoryImportRun"
    SET
      "status" = 'PARTIAL'::"SpotifyExtendedHistoryImportStatus",
      "finishedAt" = CURRENT_TIMESTAMP,
      "error" = ${error}
    WHERE "id" = ${runId}
  `);
}
