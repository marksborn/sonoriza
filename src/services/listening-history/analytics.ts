import type { ListeningEventSource, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  HISTORY_ANALYTICS_USES,
  sqlAggregateListeningEventSourcesForUses,
} from "@/services/data-policy";

import {
  buildCanonicalListeningEventWhere,
  getCanonicalLastFmHistoryWindow,
} from "./canonical";

export type ListeningSourceCount = {
  source: ListeningEventSource;
  count: number;
};

export type ListeningHistorySummary = {
  totalPlayEvents: number;
  firstPlayedAt: Date | null;
  lastPlayedAt: Date | null;
  sources: ListeningSourceCount[];
  lastFmBackfill: {
    runId: string;
    username: string;
    status: string;
    historyUntil: Date;
    profilePlayCount: number | null;
    acceptedEvents: number;
    insertedEvents: number;
    duplicateEvents: number;
  } | null;
};

export type TrackListeningStatsInput = {
  spotifyTrackId?: string | null;
  trackName: string;
  artistName: string;
  albumName?: string | null;
};

export type TrackListeningStats = {
  identityBasis: "SPOTIFY_ID" | "UNRESOLVED_NAME";
  playCount: number;
  firstPlayedAt: Date | null;
  lastPlayedAt: Date | null;
  sources: ListeningSourceCount[];
  unresolvedHistoricalCandidates: {
    count: number;
    firstPlayedAt: Date | null;
    lastPlayedAt: Date | null;
  };
};

/**
 * Gate 5C keeps operational import/backfill status visible while behavioral
 * timeline counts remain fail-closed. No current ListeningEventSource has an
 * explicit lineage-safe SQL/aggregate contract plus ALLOW for analytics.
 */
export async function getListeningHistorySummary(
  userId: string,
): Promise<ListeningHistorySummary> {
  const backfill = await prisma.lastFmBackfillRun.findFirst({
    where: { userId },
    orderBy: { startedAt: "desc" },
  });
  const allowedSources = sqlAggregateListeningEventSourcesForUses(
    HISTORY_ANALYTICS_USES,
  );

  if (allowedSources.length === 0) {
    return {
      totalPlayEvents: 0,
      firstPlayedAt: null,
      lastPlayedAt: null,
      sources: [],
      lastFmBackfill: toLastFmBackfillView(backfill),
    };
  }

  const lastFmWindow = await getCanonicalLastFmHistoryWindow(userId);
  const canonicalWhere = buildCanonicalListeningEventWhere({
    userId,
    lastFmWindow,
    extra: {
      source: { in: allowedSources as ListeningEventSource[] },
    },
  });

  const [aggregate, sources] = await Promise.all([
    prisma.trackListeningEvent.aggregate({
      where: canonicalWhere,
      _count: { _all: true },
      _min: { playedAt: true },
      _max: { playedAt: true },
    }),
    prisma.trackListeningEvent.groupBy({
      by: ["source"],
      where: canonicalWhere,
      _count: { _all: true },
    }),
  ]);

  return {
    totalPlayEvents: aggregate._count._all,
    firstPlayedAt: aggregate._min.playedAt,
    lastPlayedAt: aggregate._max.playedAt,
    sources: sources.map((entry) => ({
      source: entry.source,
      count: entry._count._all,
    })),
    lastFmBackfill: toLastFmBackfillView(backfill),
  };
}

/**
 * Counts are behavioral analytics, so provider rows are not queried while the
 * capability set is empty. Identity labels remain input/display concerns; they
 * do not grant permission to aggregate the underlying provider history.
 */
export async function getTrackListeningStats(
  userId: string,
  input: TrackListeningStatsInput,
): Promise<TrackListeningStats> {
  const trackName = requiredText(input.trackName, "trackName");
  const artistName = requiredText(input.artistName, "artistName");
  const albumName = input.albumName?.trim() || null;
  const spotifyTrackId = input.spotifyTrackId?.trim() || null;
  const allowedSources = sqlAggregateListeningEventSourcesForUses(
    HISTORY_ANALYTICS_USES,
  );

  if (allowedSources.length === 0) {
    return {
      identityBasis: spotifyTrackId ? "SPOTIFY_ID" : "UNRESOLVED_NAME",
      playCount: 0,
      firstPlayedAt: null,
      lastPlayedAt: null,
      sources: [],
      unresolvedHistoricalCandidates: {
        count: 0,
        firstPlayedAt: null,
        lastPlayedAt: null,
      },
    };
  }

  const lastFmWindow = await getCanonicalLastFmHistoryWindow(userId);
  const sourceFilter = {
    source: { in: allowedSources as ListeningEventSource[] },
  } satisfies Prisma.TrackListeningEventWhereInput;
  const unresolvedExtra = {
    ...unresolvedNameExtra({ trackName, artistName, albumName }),
    ...sourceFilter,
  } satisfies Prisma.TrackListeningEventWhereInput;
  const unresolvedWhere = buildCanonicalListeningEventWhere({
    userId,
    lastFmWindow,
    extra: unresolvedExtra,
  });
  const canonicalWhere = buildCanonicalListeningEventWhere({
    userId,
    lastFmWindow,
    extra: spotifyTrackId
      ? { spotifyTrackId, ...sourceFilter }
      : unresolvedExtra,
  });

  const [aggregate, sources, unresolvedAggregate] = await Promise.all([
    prisma.trackListeningEvent.aggregate({
      where: canonicalWhere,
      _count: { _all: true },
      _min: { playedAt: true },
      _max: { playedAt: true },
    }),
    prisma.trackListeningEvent.groupBy({
      by: ["source"],
      where: canonicalWhere,
      _count: { _all: true },
    }),
    spotifyTrackId
      ? prisma.trackListeningEvent.aggregate({
          where: unresolvedWhere,
          _count: { _all: true },
          _min: { playedAt: true },
          _max: { playedAt: true },
        })
      : Promise.resolve({
          _count: { _all: 0 },
          _min: { playedAt: null as Date | null },
          _max: { playedAt: null as Date | null },
        }),
  ]);

  return {
    identityBasis: spotifyTrackId ? "SPOTIFY_ID" : "UNRESOLVED_NAME",
    playCount: aggregate._count._all,
    firstPlayedAt: aggregate._min.playedAt,
    lastPlayedAt: aggregate._max.playedAt,
    sources: sources.map((entry) => ({
      source: entry.source,
      count: entry._count._all,
    })),
    unresolvedHistoricalCandidates: {
      count: unresolvedAggregate._count._all,
      firstPlayedAt: unresolvedAggregate._min.playedAt,
      lastPlayedAt: unresolvedAggregate._max.playedAt,
    },
  };
}

function toLastFmBackfillView(
  backfill: Awaited<ReturnType<typeof prisma.lastFmBackfillRun.findFirst>>,
): ListeningHistorySummary["lastFmBackfill"] {
  return backfill
    ? {
        runId: backfill.id,
        username: backfill.username,
        status: backfill.status,
        historyUntil: backfill.to,
        profilePlayCount: backfill.profilePlayCount,
        acceptedEvents: backfill.acceptedEvents,
        insertedEvents: backfill.insertedEvents,
        duplicateEvents: backfill.duplicateEvents,
      }
    : null;
}

function unresolvedNameExtra(input: {
  trackName: string;
  artistName: string;
  albumName: string | null;
}): Prisma.TrackListeningEventWhereInput {
  return {
    spotifyTrackId: null,
    trackName: { equals: input.trackName, mode: "insensitive" },
    artistName: { equals: input.artistName, mode: "insensitive" },
    ...(input.albumName
      ? { albumName: { equals: input.albumName, mode: "insensitive" } }
      : {}),
  };
}

function requiredText(value: string, name: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${name} is required for listening stats`);
  return cleaned;
}
