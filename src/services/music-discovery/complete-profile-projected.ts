import type { ListeningEventSource, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

import {
  COMPLETE_PROFILE_EVENT_BATCH_SIZE,
  getBatchedCompleteMusicDiscoveryProfile,
  getBatchedRetainedCompleteMusicDiscoveryProfile,
  type RetainedCompleteMusicDiscoveryProfile,
} from "./complete-profile-batched";
import type {
  MusicDiscoveryProfile,
  MusicDiscoveryProfileOptions,
} from "./profile";

type CompleteProfileOptions = Omit<
  MusicDiscoveryProfileOptions,
  "topN" | "completeUniverse"
>;

type BatchedFindManyArgs = {
  where?: { userId?: unknown };
  orderBy?: { id?: unknown };
  take?: unknown;
  cursor?: { id?: unknown };
  skip?: unknown;
};

type ProjectedCompleteHistoryRow = {
  id: string;
  source: string;
  spotifyTrackId: string | null;
  spotifyUri: string | null;
  trackName: string;
  artistName: string;
  albumName: string | null;
  playedAt: Date;
  extendedEvidencePresent: boolean;
  msPlayed: number | null;
  explicitSkip: boolean;
};

const LISTENING_EVENT_SOURCES = new Set<string>([
  "SPOTIFY_RECENTLY_PLAYED",
  "SPOTIFY_EXTENDED_HISTORY",
  "LASTFM_SCROBBLE",
  "IMPORT",
]);

/**
 * PERF-01 third cut.
 *
 * The batched loader removed the six-figure event array from the Node heap, but
 * each 2k page still asked Prisma to deserialize the complete JSON metadata for
 * every event. The canonical profile only observes three facts from
 * metadata.spotifyExtendedHistory, so this adapter projects those facts in
 * PostgreSQL and reconstructs the smallest metadata shape that preserves the
 * existing aggregator contract.
 *
 * Keeping the canonical aggregator untouched is deliberate: this optimization
 * must not redefine aliases, cooldown, skip semantics, momentum or ranking.
 */
export async function getProjectedBatchedCompleteMusicDiscoveryProfile(
  userId: string,
  options: CompleteProfileOptions = {},
): Promise<MusicDiscoveryProfile> {
  const client = options.client ?? defaultPrisma;
  const projectedClient = createProjectedHistoryClient(client);

  return getBatchedCompleteMusicDiscoveryProfile(userId, {
    ...options,
    client: projectedClient,
  });
}

/**
 * PERF-01 runtime path. Uses the same SQL projection and paged aggregation as
 * the canonical profile, but asks the batched loader for only the historical
 * universes and context required by runtime scoring.
 */
export async function getProjectedBatchedRetainedCompleteMusicDiscoveryProfile(
  userId: string,
  options: CompleteProfileOptions = {},
): Promise<RetainedCompleteMusicDiscoveryProfile> {
  const client = options.client ?? defaultPrisma;
  const projectedClient = createProjectedHistoryClient(client);

  return getBatchedRetainedCompleteMusicDiscoveryProfile(userId, {
    ...options,
    client: projectedClient,
  });
}

function createProjectedHistoryClient(client: PrismaClient): PrismaClient {
  // getBatchedCompleteMusicDiscoveryProfile only uses these delegates. Supplying
  // a narrow adapter avoids proxying Prisma internals while replacing exactly
  // the heavy TrackListeningEvent.findMany call.
  return {
    user: client.user,
    musicPreferenceSignal: client.musicPreferenceSignal,
    trackListeningState: client.trackListeningState,
    musicPlaybackPolicy: client.musicPlaybackPolicy,
    lastFmBackfillRun: client.lastFmBackfillRun,
    trackListeningEvent: {
      findMany: async (args: BatchedFindManyArgs) =>
        loadProjectedEventPage(client, args),
    },
  } as unknown as PrismaClient;
}

async function loadProjectedEventPage(
  client: PrismaClient,
  args: BatchedFindManyArgs,
): Promise<
  Array<{
    id: string;
    source: ListeningEventSource;
    spotifyTrackId: string | null;
    spotifyUri: string | null;
    trackName: string;
    artistName: string;
    albumName: string | null;
    playedAt: Date;
    metadata: unknown;
  }>
> {
  const userId = args.where?.userId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("PERF-01 projected history requires where.userId");
  }
  if (args.orderBy?.id !== "asc") {
    throw new Error("PERF-01 projected history requires orderBy.id=asc");
  }
  if (args.take !== COMPLETE_PROFILE_EVENT_BATCH_SIZE) {
    throw new Error(
      `PERF-01 projected history requires take=${COMPLETE_PROFILE_EVENT_BATCH_SIZE}`,
    );
  }

  const cursorId = args.cursor?.id;
  if (cursorId !== undefined && typeof cursorId !== "string") {
    throw new Error("PERF-01 projected history cursor.id must be a string");
  }
  if (cursorId !== undefined && args.skip !== 1) {
    throw new Error("PERF-01 projected history requires skip=1 with a cursor");
  }
  if (cursorId === undefined && args.skip !== undefined) {
    throw new Error("PERF-01 projected history does not expect skip without cursor");
  }

  const rows = await client.$queryRawUnsafe<ProjectedCompleteHistoryRow[]>(
    `
      /* PERF-01: project only the Extended History facts consumed by DISCOVERY */
      SELECT
        "id",
        "source"::text AS "source",
        "spotifyTrackId",
        "spotifyUri",
        "trackName",
        "artistName",
        "albumName",
        "playedAt",
        (jsonb_typeof("metadata"->'spotifyExtendedHistory') = 'object')
          AS "extendedEvidencePresent",
        CASE
          WHEN jsonb_typeof("metadata"->'spotifyExtendedHistory') = 'object'
           AND jsonb_typeof("metadata"->'spotifyExtendedHistory'->'msPlayed') = 'number'
          THEN ("metadata"->'spotifyExtendedHistory'->>'msPlayed')::double precision
          ELSE NULL
        END AS "msPlayed",
        CASE
          WHEN jsonb_typeof("metadata"->'spotifyExtendedHistory') = 'object'
          THEN
            COALESCE(
              CASE
                WHEN jsonb_typeof("metadata"->'spotifyExtendedHistory'->'explicitSkip') = 'boolean'
                THEN ("metadata"->'spotifyExtendedHistory'->>'explicitSkip')::boolean
                ELSE false
              END,
              false
            )
            OR
            COALESCE(
              CASE
                WHEN jsonb_typeof("metadata"->'spotifyExtendedHistory'->'skipped') = 'boolean'
                THEN ("metadata"->'spotifyExtendedHistory'->>'skipped')::boolean
                ELSE false
              END,
              false
            )
          ELSE false
        END AS "explicitSkip"
      FROM "TrackListeningEvent"
      WHERE "userId" = $1
        AND ($2::text IS NULL OR "id" > $2::text)
      ORDER BY "id" ASC
      LIMIT $3
    `,
    userId,
    cursorId ?? null,
    COMPLETE_PROFILE_EVENT_BATCH_SIZE,
  );

  return rows.map((row) => ({
    id: row.id,
    source: listeningEventSource(row.source),
    spotifyTrackId: row.spotifyTrackId,
    spotifyUri: row.spotifyUri,
    trackName: row.trackName,
    artistName: row.artistName,
    albumName: row.albumName,
    playedAt: row.playedAt,
    metadata: minimalExtendedHistoryMetadata(row),
  }));
}

function minimalExtendedHistoryMetadata(
  row: ProjectedCompleteHistoryRow,
): unknown {
  if (!row.extendedEvidencePresent) return null;

  return {
    spotifyExtendedHistory: {
      ...(row.msPlayed === null ? {} : { msPlayed: row.msPlayed }),
      ...(row.explicitSkip ? { explicitSkip: true } : {}),
    },
  };
}

function listeningEventSource(value: string): ListeningEventSource {
  if (!LISTENING_EVENT_SOURCES.has(value)) {
    throw new Error(`Unknown listening event source from projected history: ${value}`);
  }
  return value as ListeningEventSource;
}
