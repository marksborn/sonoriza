import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

import type { SpotifyExtendedMusicEvent } from "./parser";
import {
  buildSpotifyExtendedPersistencePlan,
  type SpotifyExtendedPersistencePlan,
} from "./persistence-plan";
import type { SpotifyExtendedReconciliation } from "./reconcile";

const DEFAULT_BATCH_SIZE = 500;

export type ApplySpotifyExtendedHistoryOptions = {
  userId: string;
  packageSha256: string;
  expectedPackageSha256: string;
  expectedPlanHash: string;
  reconciliation: SpotifyExtendedReconciliation;
  client?: PrismaClient;
  batchSize?: number;
};

export type ApplySpotifyExtendedHistoryResult = {
  runId: string;
  planHash: string;
  insertedEvents: number;
  enrichedEvents: number;
  duplicateEvents: number;
  noopEvents: number;
  quarantinedEvents: number;
};

/**
 * HISTORY-02 persistence writer.
 *
 * This function deliberately accepts an already-reconciled, frozen plan. It
 * does not call Spotify/Last.fm, does not generate playlists and never updates
 * TrackListeningState. Historical rows enrich the factual timeline only.
 *
 * The caller must supply both the expected package SHA and expected plan hash.
 * Any drift aborts before the audit run or listening history is written.
 */
export async function applySpotifyExtendedHistory(
  options: ApplySpotifyExtendedHistoryOptions,
): Promise<ApplySpotifyExtendedHistoryResult> {
  const client = options.client ?? defaultPrisma;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
    throw new Error("HISTORY-02 batchSize must be an integer between 1 and 2000");
  }

  if (options.packageSha256 !== options.expectedPackageSha256) {
    throw new Error("HISTORY-02 package SHA does not match the frozen dry-run");
  }

  const plan = buildSpotifyExtendedPersistencePlan(
    options.packageSha256,
    options.reconciliation,
  );
  if (plan.planHash !== options.expectedPlanHash) {
    throw new Error("HISTORY-02 persistence plan hash does not match the frozen dry-run");
  }

  const eventBySourceKey = new Map(
    options.reconciliation.entries.map((entry) => [entry.event.sourceEventKey, entry.event] as const),
  );
  if (eventBySourceKey.size !== options.reconciliation.entries.length) {
    throw new Error("HISTORY-02 reconciliation contains duplicate sourceEventKey values");
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
        const event = eventBySourceKey.get(action.sourceEventKey);
        if (!event) {
          throw new Error(`HISTORY-02 planned sourceEventKey is missing: ${action.sourceEventKey}`);
        }

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
    ${randomUUID()},
    ${userId},
    ${event.spotifyTrackId},
    ${event.spotifyTrackUri},
    ${event.trackName},
    ${event.artistName},
    ${null},
    ${event.albumName},
    ${null},
    ${null},
    ${null},
    ${null},
    ${null},
    ${event.estimatedStartedAt},
    'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource",
    ${event.sourceEventKey},
    ${null},
    ${null},
    ${JSON.stringify(toExtendedMetadata(packageSha256, event))}::jsonb
  )`);

  return tx.$executeRaw(Prisma.sql`
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
    VALUES ${Prisma.join(rows)}
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
    ${JSON.stringify(toExtendedMetadata(packageSha256, event))}::jsonb
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

function toExtendedMetadata(packageSha256: string, event: SpotifyExtendedMusicEvent) {
  return {
    spotifyExtendedHistory: {
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
    },
  };
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
