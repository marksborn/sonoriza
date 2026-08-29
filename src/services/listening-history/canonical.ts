import type { Prisma } from "@prisma/client";

export type LastFmHistoryWindow = {
  from: Date | null;
  to: Date;
} | null;

/**
 * HISTORY-01 established Last.fm as a bounded historical backfill source.
 * Rows outside the successful backfill window can remain in storage as known
 * legacy residue, but they are not canonical listening events and must not feed
 * explorer/analytics results.
 */
export function buildCanonicalListeningEventWhere(input: {
  userId: string;
  lastFmWindow: LastFmHistoryWindow;
  extra?: Prisma.TrackListeningEventWhereInput;
}): Prisma.TrackListeningEventWhereInput {
  const canonicalSourceWhere: Prisma.TrackListeningEventWhereInput =
    input.lastFmWindow
      ? {
          OR: [
            { source: { not: "LASTFM_SCROBBLE" } },
            {
              source: "LASTFM_SCROBBLE",
              playedAt: {
                ...(input.lastFmWindow.from
                  ? { gte: input.lastFmWindow.from }
                  : {}),
                lt: input.lastFmWindow.to,
              },
            },
          ],
        }
      : {
          // Last.fm rows without an authoritative successful backfill window
          // are not promoted to canonical history.
          source: { not: "LASTFM_SCROBBLE" },
        };

  return {
    AND: [
      { userId: input.userId },
      canonicalSourceWhere,
      ...(input.extra ? [input.extra] : []),
    ],
  };
}
