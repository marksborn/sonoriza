import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  HISTORY_ANALYTICS_USES,
  sqlAggregateListeningEventSourcesForUses,
} from "@/services/data-policy";

import { getCanonicalLastFmHistoryWindow, type LastFmHistoryWindow } from "./canonical";
import type { ListeningHistoryFilters } from "./explorer";

export type ListeningHistoryTrackRanking = {
  trackName: string;
  artistName: string;
  playCount: number;
};

export type ListeningHistoryArtistRanking = {
  artistName: string;
  playCount: number;
};

export type ListeningHistoryAlbumRanking = {
  albumName: string;
  artistName: string;
  playCount: number;
};

export type ListeningHistoryStats = {
  playCount: number;
  distinctTracks: number;
  distinctArtists: number;
  distinctAlbums: number;
  measuredPlayEvents: number;
  measuredListeningMs: number;
  measuredCoveragePercent: number;
  topTracks: ListeningHistoryTrackRanking[];
  topArtists: ListeningHistoryArtistRanking[];
  topAlbums: ListeningHistoryAlbumRanking[];
  policy: {
    use: "BEHAVIORAL_ANALYTICS";
    status: "ACTIVE" | "QUARANTINED";
    allowedSources: readonly string[];
  };
};

type StatsFilters = Pick<
  ListeningHistoryFilters,
  "from" | "toExclusive" | "query" | "source"
>;

type OverviewRow = {
  playCount: bigint;
  distinctTracks: bigint;
  distinctArtists: bigint;
  distinctAlbums: bigint;
  measuredPlayEvents: bigint;
  measuredListeningMs: bigint;
};

type TrackRankingRow = {
  trackName: string;
  artistName: string;
  playCount: bigint;
};

type ArtistRankingRow = {
  artistName: string;
  playCount: bigint;
};

type AlbumRankingRow = {
  albumName: string;
  artistName: string;
  playCount: bigint;
};

const NORMALIZED_ARTIST_SQL = Prisma.raw(
  `lower(regexp_replace(btrim(e."artistName"), '[[:space:]]+', ' ', 'g'))`,
);
const NORMALIZED_TRACK_SQL = Prisma.raw(
  `lower(regexp_replace(btrim(e."trackName"), '[[:space:]]+', ' ', 'g'))`,
);
const NORMALIZED_ALBUM_SQL = Prisma.raw(
  `lower(regexp_replace(btrim(e."albumName"), '[[:space:]]+', ' ', 'g'))`,
);
const MEASURED_MS_TEXT_SQL = Prisma.raw(
  `e."metadata" #>> '{spotifyExtendedHistory,msPlayed}'`,
);

/**
 * HISTORY-04 statistics boundary.
 *
 * Gate 5C no longer lets a SQL aggregate see provider listening rows unless a
 * source has both an explicit lineage-safe SQL contract and ALLOW for
 * BEHAVIORAL_ANALYTICS. Under the current matrix that set is empty, so the
 * analytics surface returns a truthful quarantined empty result while the raw
 * explorer/display path remains separate.
 */
export async function getListeningHistoryStats(
  userId: string,
  filters: StatsFilters,
): Promise<ListeningHistoryStats> {
  const allowedSources = sqlAggregateListeningEventSourcesForUses(
    HISTORY_ANALYTICS_USES,
  );
  if (allowedSources.length === 0) {
    return emptyStats("QUARANTINED", allowedSources);
  }

  const lastFmWindow = await getCanonicalLastFmHistoryWindow(userId);
  const where = buildStatsWhere(userId, filters, lastFmWindow, allowedSources);

  const [overviewRows, topTracksRows, topArtistsRows, topAlbumsRows] =
    await Promise.all([
      prisma.$queryRaw<OverviewRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS "playCount",
          COUNT(DISTINCT (${NORMALIZED_ARTIST_SQL}, ${NORMALIZED_TRACK_SQL}))::bigint AS "distinctTracks",
          COUNT(DISTINCT ${NORMALIZED_ARTIST_SQL})::bigint AS "distinctArtists",
          COUNT(DISTINCT (${NORMALIZED_ARTIST_SQL}, ${NORMALIZED_ALBUM_SQL}))
            FILTER (WHERE e."albumName" IS NOT NULL AND btrim(e."albumName") <> '')::bigint AS "distinctAlbums",
          COUNT(*) FILTER (
            WHERE COALESCE(${MEASURED_MS_TEXT_SQL}, '') ~ '^[0-9]+$'
          )::bigint AS "measuredPlayEvents",
          COALESCE(SUM(
            CASE
              WHEN COALESCE(${MEASURED_MS_TEXT_SQL}, '') ~ '^[0-9]+$'
                THEN (${MEASURED_MS_TEXT_SQL})::bigint
              ELSE 0
            END
          ), 0)::bigint AS "measuredListeningMs"
        FROM "TrackListeningEvent" e
        WHERE ${where}
      `),
      prisma.$queryRaw<TrackRankingRow[]>(Prisma.sql`
        SELECT
          (array_agg(e."trackName" ORDER BY e."playedAt" DESC, e."id" DESC))[1] AS "trackName",
          (array_agg(e."artistName" ORDER BY e."playedAt" DESC, e."id" DESC))[1] AS "artistName",
          COUNT(*)::bigint AS "playCount"
        FROM "TrackListeningEvent" e
        WHERE ${where}
        GROUP BY ${NORMALIZED_ARTIST_SQL}, ${NORMALIZED_TRACK_SQL}
        ORDER BY COUNT(*) DESC, ${NORMALIZED_ARTIST_SQL} ASC, ${NORMALIZED_TRACK_SQL} ASC
        LIMIT 5
      `),
      prisma.$queryRaw<ArtistRankingRow[]>(Prisma.sql`
        SELECT
          (array_agg(e."artistName" ORDER BY e."playedAt" DESC, e."id" DESC))[1] AS "artistName",
          COUNT(*)::bigint AS "playCount"
        FROM "TrackListeningEvent" e
        WHERE ${where}
        GROUP BY ${NORMALIZED_ARTIST_SQL}
        ORDER BY COUNT(*) DESC, ${NORMALIZED_ARTIST_SQL} ASC
        LIMIT 5
      `),
      prisma.$queryRaw<AlbumRankingRow[]>(Prisma.sql`
        SELECT
          (array_agg(e."albumName" ORDER BY e."playedAt" DESC, e."id" DESC))[1] AS "albumName",
          (array_agg(e."artistName" ORDER BY e."playedAt" DESC, e."id" DESC))[1] AS "artistName",
          COUNT(*)::bigint AS "playCount"
        FROM "TrackListeningEvent" e
        WHERE ${where}
          AND e."albumName" IS NOT NULL
          AND btrim(e."albumName") <> ''
        GROUP BY ${NORMALIZED_ARTIST_SQL}, ${NORMALIZED_ALBUM_SQL}
        ORDER BY COUNT(*) DESC, ${NORMALIZED_ARTIST_SQL} ASC, ${NORMALIZED_ALBUM_SQL} ASC
        LIMIT 5
      `),
    ]);

  const overview = overviewRows[0] ?? {
    playCount: 0n,
    distinctTracks: 0n,
    distinctArtists: 0n,
    distinctAlbums: 0n,
    measuredPlayEvents: 0n,
    measuredListeningMs: 0n,
  };
  const playCount = toSafeNumber(overview.playCount);
  const measuredPlayEvents = toSafeNumber(overview.measuredPlayEvents);

  return {
    playCount,
    distinctTracks: toSafeNumber(overview.distinctTracks),
    distinctArtists: toSafeNumber(overview.distinctArtists),
    distinctAlbums: toSafeNumber(overview.distinctAlbums),
    measuredPlayEvents,
    measuredListeningMs: toSafeNumber(overview.measuredListeningMs),
    measuredCoveragePercent:
      playCount > 0 ? Math.round((measuredPlayEvents / playCount) * 1000) / 10 : 0,
    topTracks: topTracksRows.map((row) => ({
      trackName: row.trackName,
      artistName: row.artistName,
      playCount: toSafeNumber(row.playCount),
    })),
    topArtists: topArtistsRows.map((row) => ({
      artistName: row.artistName,
      playCount: toSafeNumber(row.playCount),
    })),
    topAlbums: topAlbumsRows.map((row) => ({
      albumName: row.albumName,
      artistName: row.artistName,
      playCount: toSafeNumber(row.playCount),
    })),
    policy: {
      use: "BEHAVIORAL_ANALYTICS",
      status: "ACTIVE",
      allowedSources,
    },
  };
}

function emptyStats(
  status: "ACTIVE" | "QUARANTINED",
  allowedSources: readonly string[],
): ListeningHistoryStats {
  return {
    playCount: 0,
    distinctTracks: 0,
    distinctArtists: 0,
    distinctAlbums: 0,
    measuredPlayEvents: 0,
    measuredListeningMs: 0,
    measuredCoveragePercent: 0,
    topTracks: [],
    topArtists: [],
    topAlbums: [],
    policy: {
      use: "BEHAVIORAL_ANALYTICS",
      status,
      allowedSources,
    },
  };
}

function buildStatsWhere(
  userId: string,
  filters: StatsFilters,
  lastFmWindow: LastFmHistoryWindow,
  allowedSources: readonly string[],
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`e."userId" = ${userId}`];
  const sourceSql = Prisma.join(
    allowedSources.map(
      (source) => Prisma.sql`${source}::"ListeningEventSource"`,
    ),
    ", ",
  );
  conditions.push(Prisma.sql`e."source" IN (${sourceSql})`);

  if (lastFmWindow) {
    const lastFmBounds: Prisma.Sql[] = [
      Prisma.sql`e."playedAt" < ${lastFmWindow.to}`,
    ];
    if (lastFmWindow.from) {
      lastFmBounds.unshift(Prisma.sql`e."playedAt" >= ${lastFmWindow.from}`);
    }
    conditions.push(Prisma.sql`(
      e."source" <> 'LASTFM_SCROBBLE'::"ListeningEventSource"
      OR (
        e."source" = 'LASTFM_SCROBBLE'::"ListeningEventSource"
        AND ${Prisma.join(lastFmBounds, " AND ")}
      )
    )`);
  } else {
    conditions.push(
      Prisma.sql`e."source" <> 'LASTFM_SCROBBLE'::"ListeningEventSource"`,
    );
  }

  if (filters.from) {
    conditions.push(Prisma.sql`e."playedAt" >= ${filters.from}`);
  }
  if (filters.toExclusive) {
    conditions.push(Prisma.sql`e."playedAt" < ${filters.toExclusive}`);
  }
  if (filters.source) {
    conditions.push(
      Prisma.sql`e."source" = ${filters.source}::"ListeningEventSource"`,
    );
  }
  if (filters.query) {
    const pattern = `%${filters.query}%`;
    conditions.push(Prisma.sql`(
      e."trackName" ILIKE ${pattern}
      OR e."artistName" ILIKE ${pattern}
      OR e."albumName" ILIKE ${pattern}
    )`);
  }

  return Prisma.join(conditions, " AND ");
}

function toSafeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error("Listening history aggregate exceeds JavaScript safe integer range");
  }
  return result;
}
