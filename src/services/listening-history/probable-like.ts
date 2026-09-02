import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  HISTORY_RECOMMENDATION_USES,
  sqlAggregateListeningEventSourcesForUses,
} from "@/services/data-policy";
import {
  inferMusicEvidenceFromSequence,
  readFactualMusicEvidence,
  readRecentlyPlayedDurationMs,
} from "./evidence";
import {
  getCanonicalLastFmHistoryWindow,
  type LastFmHistoryWindow,
} from "./canonical";
import { probableLikeTrackIdentityKey } from "./probable-like-spotify-identity";

export type ProbableLikeCandidate = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  playCount: number;
  distinctDays: number;
  factualCompleteCount: number;
  factualSkipCount: number;
  knownTrackDurationMs: number | null;
  maxFactualCompleteMsPlayed: number | null;
  inferredCompleteCount: number;
  inferredSkipCount: number;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  score: number;
  reasons: string[];
};

export type ProbableLikeShadowResult = {
  generatedAt: Date;
  candidates: ProbableLikeCandidate[];
  evaluatedTrackCount: number;
  excludedLikedCount: number;
  excludedStrongNegativeCount: number;
  excludedShortContentCount: number;
};

export type ProbableLikeAggregate = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  playCount: number;
  distinctDays: number;
  factualCompleteCount: number;
  factualSkipCount: number;
  knownTrackDurationMs: number | null;
  maxFactualCompleteMsPlayed: number | null;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
};

type AggregateRow = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  playCount: bigint;
  distinctDays: bigint;
  factualCompleteCount: bigint;
  factualSkipCount: bigint;
  knownTrackDurationMs: bigint | null;
  maxFactualCompleteMsPlayed: bigint | null;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
};

type RecentEvent = {
  spotifyTrackId: string | null;
  playedAt: Date;
  source: string;
  metadata: unknown;
};

const RECENT_INFERENCE_WINDOW_DAYS = 90;
const MIN_PLAYS = 3;
const MIN_DISTINCT_DAYS = 2;
const MAX_RANKED_AGGREGATES = 1_000;
const DEFAULT_LIMIT = 10;

const SHORT_CONTENT_MAX_MS = 15_000;
const MIN_SHORT_FACTUAL_COMPLETIONS = 2;

/**
 * HISTORY-04 ranking runtime.
 *
 * Gate 5C requires every source entering this behavioral/profile/recommendation
 * aggregate to be explicitly lineage-safe and ALLOWed for all required uses.
 * No current ListeningEventSource qualifies, so the runtime returns an empty
 * ranking before reading history, Saved Tracks, inferred skips or sequence
 * completion evidence. The pure ranker remains below for diagnostic tests only.
 */
export async function getProbableLikeShadow(
  userId: string,
  options: { now?: Date; limit?: number } = {},
): Promise<ProbableLikeShadowResult> {
  const now = options.now ?? new Date();
  const allowedSources = sqlAggregateListeningEventSourcesForUses(
    HISTORY_RECOMMENDATION_USES,
  );
  if (allowedSources.length === 0) {
    return emptyProbableLikeShadow(now);
  }

  const limit = clamp(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1, 25);
  const lastFmWindow = await getCanonicalLastFmHistoryWindow(userId);

  const [aggregates, likedRows, skipRows, inferredCompleteCounts] =
    await Promise.all([
      loadProbableLikeAggregates(userId, lastFmWindow, allowedSources),
      prisma.likedTrackPreference.findMany({
        where: { userId, isLiked: true },
        select: {
          spotifyTrackId: true,
          trackName: true,
          primaryArtistName: true,
        },
      }),
      prisma.musicPreferenceSignal.groupBy({
        by: ["spotifyTrackId"],
        where: { userId, type: "INFERRED_SKIP" },
        _count: { _all: true },
      }),
      loadRecentInferredCompletionCounts(userId, now, allowedSources),
    ]);

  const likedTrackIdentityKeys = new Set<string>();
  for (const row of likedRows) {
    const key = probableLikeTrackIdentityKey({
      trackName: row.trackName,
      artistName: row.primaryArtistName,
    });
    if (key) likedTrackIdentityKeys.add(key);
  }

  return rankProbableLikeAggregates({
    aggregates,
    likedTrackIds: new Set(likedRows.map((row) => row.spotifyTrackId)),
    likedTrackIdentityKeys,
    inferredSkipCounts: new Map(
      skipRows.map((row) => [row.spotifyTrackId, row._count._all]),
    ),
    inferredCompleteCounts,
    now,
    limit,
  });
}

export function rankProbableLikeAggregates(input: {
  aggregates: ProbableLikeAggregate[];
  likedTrackIds: ReadonlySet<string>;
  likedTrackIdentityKeys?: ReadonlySet<string>;
  inferredSkipCounts?: ReadonlyMap<string, number>;
  inferredCompleteCounts?: ReadonlyMap<string, number>;
  now?: Date;
  limit?: number;
}): ProbableLikeShadowResult {
  const now = input.now ?? new Date();
  const limit = clamp(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1, 25);
  const likedTrackIdentityKeys = input.likedTrackIdentityKeys ?? new Set<string>();
  const inferredSkips = input.inferredSkipCounts ?? new Map<string, number>();
  const inferredCompletes =
    input.inferredCompleteCounts ?? new Map<string, number>();

  let excludedLikedCount = 0;
  let excludedStrongNegativeCount = 0;
  let excludedShortContentCount = 0;
  const candidates: ProbableLikeCandidate[] = [];

  for (const aggregate of input.aggregates) {
    const aggregateIdentityKey = probableLikeTrackIdentityKey(aggregate);
    if (
      input.likedTrackIds.has(aggregate.spotifyTrackId) ||
      (aggregateIdentityKey !== null && likedTrackIdentityKeys.has(aggregateIdentityKey))
    ) {
      excludedLikedCount += 1;
      continue;
    }

    if (isUltraShortContent(aggregate)) {
      excludedShortContentCount += 1;
      continue;
    }

    if (
      aggregate.playCount < MIN_PLAYS ||
      aggregate.distinctDays < MIN_DISTINCT_DAYS
    ) {
      continue;
    }

    const inferredCompleteCount = Math.max(
      0,
      inferredCompletes.get(aggregate.spotifyTrackId) ?? 0,
    );
    const inferredSkipCount = Math.max(
      0,
      inferredSkips.get(aggregate.spotifyTrackId) ?? 0,
    );
    const negativeCount = aggregate.factualSkipCount + inferredSkipCount;
    const strongNegativeThreshold = Math.max(
      2,
      Math.ceil(aggregate.playCount * 0.5),
    );
    if (negativeCount >= strongNegativeThreshold) {
      excludedStrongNegativeCount += 1;
      continue;
    }

    const hasCompletionEvidence =
      aggregate.factualCompleteCount > 0 || inferredCompleteCount > 0;
    if (!hasCompletionEvidence && aggregate.playCount < 5) continue;

    const ageDays = Math.max(
      0,
      (now.getTime() - aggregate.lastPlayedAt.getTime()) / 86_400_000,
    );
    const recencyBonus =
      ageDays <= 30 ? 5 : ageDays <= 90 ? 3 : ageDays <= 365 ? 1 : 0;
    const score =
      Math.min(aggregate.playCount, 12) * 2 +
      Math.min(aggregate.distinctDays, 8) * 4 +
      Math.min(aggregate.factualCompleteCount, 6) * 4 +
      Math.min(inferredCompleteCount, 6) * 2 +
      recencyBonus -
      Math.min(aggregate.factualSkipCount, 6) * 5 -
      Math.min(inferredSkipCount, 6) * 4;

    if (score < 18) continue;

    const reasons = buildReasons({
      ...aggregate,
      inferredCompleteCount,
      inferredSkipCount,
      ageDays,
    });

    candidates.push({
      ...aggregate,
      inferredCompleteCount,
      inferredSkipCount,
      score,
      reasons,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.distinctDays !== a.distinctDays) return b.distinctDays - a.distinctDays;
    if (b.playCount !== a.playCount) return b.playCount - a.playCount;
    return b.lastPlayedAt.getTime() - a.lastPlayedAt.getTime();
  });

  return {
    generatedAt: now,
    candidates: candidates.slice(0, limit),
    evaluatedTrackCount: input.aggregates.length,
    excludedLikedCount,
    excludedStrongNegativeCount,
    excludedShortContentCount,
  };
}

async function loadProbableLikeAggregates(
  userId: string,
  lastFmWindow: LastFmHistoryWindow,
  allowedSources: readonly string[],
): Promise<ProbableLikeAggregate[]> {
  const canonical = buildCanonicalSql(lastFmWindow);
  const sourceSql = Prisma.join(
    allowedSources.map(
      (source) => Prisma.sql`${source}::"ListeningEventSource"`,
    ),
    ", ",
  );
  const rows = await prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT
      e."spotifyTrackId" AS "spotifyTrackId",
      (ARRAY_AGG(e."trackName" ORDER BY e."playedAt" DESC))[1] AS "trackName",
      (ARRAY_AGG(e."artistName" ORDER BY e."playedAt" DESC))[1] AS "artistName",
      COUNT(*)::bigint AS "playCount",
      COUNT(DISTINCT ((e."playedAt" AT TIME ZONE 'UTC')::date))::bigint AS "distinctDays",
      COUNT(*) FILTER (
        WHERE e."metadata" #>> '{spotifyExtendedHistory,reasonEnd}' = 'trackdone'
          AND COALESCE(e."metadata" #>> '{spotifyExtendedHistory,explicitSkip}', 'false') <> 'true'
      )::bigint AS "factualCompleteCount",
      COUNT(*) FILTER (
        WHERE e."metadata" #>> '{spotifyExtendedHistory,explicitSkip}' = 'true'
          OR e."metadata" #>> '{spotifyExtendedHistory,skipped}' = 'true'
      )::bigint AS "factualSkipCount",
      MAX(
        CASE
          WHEN COALESCE(e."metadata" #>> '{spotifyRecentlyPlayed,trackDurationMs}', '') ~ '^[0-9]+$'
            THEN (e."metadata" #>> '{spotifyRecentlyPlayed,trackDurationMs}')::bigint
          ELSE NULL
        END
      )::bigint AS "knownTrackDurationMs",
      MAX(
        CASE
          WHEN e."metadata" #>> '{spotifyExtendedHistory,reasonEnd}' = 'trackdone'
            AND COALESCE(e."metadata" #>> '{spotifyExtendedHistory,explicitSkip}', 'false') <> 'true'
            AND COALESCE(e."metadata" #>> '{spotifyExtendedHistory,msPlayed}', '') ~ '^[0-9]+$'
            THEN (e."metadata" #>> '{spotifyExtendedHistory,msPlayed}')::bigint
          ELSE NULL
        END
      )::bigint AS "maxFactualCompleteMsPlayed",
      MIN(e."playedAt") AS "firstPlayedAt",
      MAX(e."playedAt") AS "lastPlayedAt"
    FROM "TrackListeningEvent" e
    WHERE e."userId" = ${userId}
      AND e."source" IN (${sourceSql})
      AND e."spotifyTrackId" IS NOT NULL
      AND ${canonical}
    GROUP BY e."spotifyTrackId"
    HAVING COUNT(*) >= ${MIN_PLAYS}
    ORDER BY COUNT(*) DESC, MAX(e."playedAt") DESC
    LIMIT ${MAX_RANKED_AGGREGATES}
  `);

  return rows.map((row) => ({
    spotifyTrackId: row.spotifyTrackId,
    trackName: row.trackName,
    artistName: row.artistName,
    playCount: toSafeNumber(row.playCount),
    distinctDays: toSafeNumber(row.distinctDays),
    factualCompleteCount: toSafeNumber(row.factualCompleteCount),
    factualSkipCount: toSafeNumber(row.factualSkipCount),
    knownTrackDurationMs: toSafeNullableNumber(row.knownTrackDurationMs),
    maxFactualCompleteMsPlayed: toSafeNullableNumber(
      row.maxFactualCompleteMsPlayed,
    ),
    firstPlayedAt: row.firstPlayedAt,
    lastPlayedAt: row.lastPlayedAt,
  }));
}

async function loadRecentInferredCompletionCounts(
  userId: string,
  now: Date,
  allowedSources: readonly string[],
): Promise<Map<string, number>> {
  const cutoff = new Date(
    now.getTime() - RECENT_INFERENCE_WINDOW_DAYS * 86_400_000,
  );
  const events = (await prisma.trackListeningEvent.findMany({
    where: {
      userId,
      playedAt: { gte: cutoff },
      source: { in: allowedSources as never[] },
    },
    orderBy: [{ playedAt: "asc" }, { id: "asc" }],
    select: {
      spotifyTrackId: true,
      playedAt: true,
      source: true,
      metadata: true,
    },
  })) as RecentEvent[];

  const counts = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      !event?.spotifyTrackId ||
      event.source !== "SPOTIFY_RECENTLY_PLAYED"
    ) {
      continue;
    }

    const durationMs = readRecentlyPlayedDurationMs(event.metadata);
    if (!durationMs) continue;
    if (readFactualMusicEvidence(event.metadata, durationMs)) continue;

    const evidence = inferMusicEvidenceFromSequence({
      playedAt: event.playedAt,
      nextPlayedAt: events[index + 1]?.playedAt ?? null,
      durationMs,
    });
    if (evidence?.status !== "COMPLETED") continue;

    counts.set(
      event.spotifyTrackId,
      (counts.get(event.spotifyTrackId) ?? 0) + 1,
    );
  }

  return counts;
}

function buildCanonicalSql(lastFmWindow: LastFmHistoryWindow): Prisma.Sql {
  if (!lastFmWindow) {
    return Prisma.sql`e."source" <> 'LASTFM_SCROBBLE'::"ListeningEventSource"`;
  }

  const bounds: Prisma.Sql[] = [
    Prisma.sql`e."playedAt" < ${lastFmWindow.to}`,
  ];
  if (lastFmWindow.from) {
    bounds.unshift(Prisma.sql`e."playedAt" >= ${lastFmWindow.from}`);
  }

  return Prisma.sql`(
    e."source" <> 'LASTFM_SCROBBLE'::"ListeningEventSource"
    OR (
      e."source" = 'LASTFM_SCROBBLE'::"ListeningEventSource"
      AND ${Prisma.join(bounds, " AND ")}
    )
  )`;
}

function emptyProbableLikeShadow(now: Date): ProbableLikeShadowResult {
  return {
    generatedAt: now,
    candidates: [],
    evaluatedTrackCount: 0,
    excludedLikedCount: 0,
    excludedStrongNegativeCount: 0,
    excludedShortContentCount: 0,
  };
}

function isUltraShortContent(aggregate: ProbableLikeAggregate): boolean {
  if (
    aggregate.knownTrackDurationMs !== null &&
    aggregate.knownTrackDurationMs > 0 &&
    aggregate.knownTrackDurationMs <= SHORT_CONTENT_MAX_MS
  ) {
    return true;
  }

  return (
    aggregate.factualCompleteCount >= MIN_SHORT_FACTUAL_COMPLETIONS &&
    aggregate.maxFactualCompleteMsPlayed !== null &&
    aggregate.maxFactualCompleteMsPlayed > 0 &&
    aggregate.maxFactualCompleteMsPlayed <= SHORT_CONTENT_MAX_MS
  );
}

function buildReasons(input: ProbableLikeAggregate & {
  inferredCompleteCount: number;
  inferredSkipCount: number;
  ageDays: number;
}): string[] {
  const reasons = [
    `Ouvida ${input.playCount} vezes em ${input.distinctDays} dias diferentes`,
  ];

  if (input.factualCompleteCount > 0) {
    reasons.push(
      `${input.factualCompleteCount} ${input.factualCompleteCount === 1 ? "conclusão factual" : "conclusões factuais"}`,
    );
  }
  if (input.inferredCompleteCount > 0) {
    reasons.push(
      `${input.inferredCompleteCount} ${input.inferredCompleteCount === 1 ? "conclusão inferida" : "conclusões inferidas"}`,
    );
  }
  if (input.ageDays <= 30) reasons.push("Reouvida nos últimos 30 dias");

  const negativeCount = input.factualSkipCount + input.inferredSkipCount;
  if (negativeCount > 0) {
    reasons.push(
      `${negativeCount} ${negativeCount === 1 ? "sinal negativo conhecido" : "sinais negativos conhecidos"}`,
    );
  }

  return reasons;
}

function toSafeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error("Probable-like aggregate exceeds JavaScript safe integer range");
  }
  return result;
}

function toSafeNullableNumber(value: bigint | null): number | null {
  return value === null ? null : toSafeNumber(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
