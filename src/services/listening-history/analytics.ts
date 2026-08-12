import type { ListeningEventSource, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

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

export async function getListeningHistorySummary(
  userId: string,
): Promise<ListeningHistorySummary> {
  const [aggregate, sources, backfill] = await Promise.all([
    prisma.trackListeningEvent.aggregate({
      where: { userId },
      _count: { _all: true },
      _min: { playedAt: true },
      _max: { playedAt: true },
    }),
    prisma.trackListeningEvent.groupBy({
      by: ["source"],
      where: { userId },
      _count: { _all: true },
    }),
    prisma.lastFmBackfillRun.findFirst({
      where: { userId },
      orderBy: { startedAt: "desc" },
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
    lastFmBackfill: backfill
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
      : null,
  };
}

/**
 * Counts a track without promoting fuzzy identity to canonical identity.
 *
 * When a Spotify id is known, `playCount` includes only rows explicitly linked
 * to that id. Unreconciled Last.fm rows with matching human-readable metadata
 * are reported separately as candidates until an identity-reconciliation pass
 * proves they refer to the same recording/version.
 *
 * When no Spotify id exists yet, name-based rows can still be inspected, but
 * the result explicitly reports `identityBasis=UNRESOLVED_NAME`.
 */
export async function getTrackListeningStats(
  userId: string,
  input: TrackListeningStatsInput,
): Promise<TrackListeningStats> {
  const trackName = requiredText(input.trackName, "trackName");
  const artistName = requiredText(input.artistName, "artistName");
  const albumName = input.albumName?.trim() || null;
  const spotifyTrackId = input.spotifyTrackId?.trim() || null;
  const unresolvedWhere = unresolvedNameWhere({
    userId,
    trackName,
    artistName,
    albumName,
  });
  const canonicalWhere: Prisma.TrackListeningEventWhereInput = spotifyTrackId
    ? { userId, spotifyTrackId }
    : unresolvedWhere;

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

function unresolvedNameWhere(input: {
  userId: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
}): Prisma.TrackListeningEventWhereInput {
  return {
    userId: input.userId,
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
