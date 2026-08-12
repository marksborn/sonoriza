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
};

export type TrackListeningStats = {
  playCount: number;
  firstPlayedAt: Date | null;
  lastPlayedAt: Date | null;
  sources: ListeningSourceCount[];
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
 * Counts one logical track across the non-overlapping HISTORY-01 sources.
 *
 * Spotify ID is preferred when present. The normalized human-readable name
 * fallback lets unmatched Last.fm history contribute before a dedicated
 * identity-reconciliation pass attaches Spotify identities to old scrobbles.
 */
export async function getTrackListeningStats(
  userId: string,
  input: TrackListeningStatsInput,
): Promise<TrackListeningStats> {
  const where = trackWhere(userId, input);
  const [aggregate, sources] = await Promise.all([
    prisma.trackListeningEvent.aggregate({
      where,
      _count: { _all: true },
      _min: { playedAt: true },
      _max: { playedAt: true },
    }),
    prisma.trackListeningEvent.groupBy({
      by: ["source"],
      where,
      _count: { _all: true },
    }),
  ]);

  return {
    playCount: aggregate._count._all,
    firstPlayedAt: aggregate._min.playedAt,
    lastPlayedAt: aggregate._max.playedAt,
    sources: sources.map((entry) => ({
      source: entry.source,
      count: entry._count._all,
    })),
  };
}

function trackWhere(
  userId: string,
  input: TrackListeningStatsInput,
): Prisma.TrackListeningEventWhereInput {
  const trackName = input.trackName.trim();
  const artistName = input.artistName.trim();
  if (!trackName || !artistName) {
    throw new Error("trackName and artistName are required for listening stats");
  }
  const spotifyTrackId = input.spotifyTrackId?.trim() || null;

  const nameMatch: Prisma.TrackListeningEventWhereInput = {
    trackName: { equals: trackName, mode: "insensitive" },
    artistName: { equals: artistName, mode: "insensitive" },
  };

  return {
    userId,
    OR: spotifyTrackId
      ? [{ spotifyTrackId }, nameMatch]
      : [nameMatch],
  };
}
