import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

export type DiscoveryTrackIdentityRow = {
  spotifyTrackId: string | null;
  isrc: string | null;
  primaryArtistId: string | null;
};

export type DiscoveryTrackIdentityEvidence = {
  spotifyTrackId: string;
  isrc: string | null;
  primaryArtistId: string | null;
  isrcConflict: boolean;
  primaryArtistIdConflict: boolean;
};

/**
 * PERF-01 identity reduction.
 *
 * The previous path asked PostgreSQL to deduplicate identity triples, then
 * materialized every distinct triple in Node and reduced them again through a
 * Map plus two Sets per track. COMPLETE runtime only needs the final identity
 * evidence, so PostgreSQL now performs the normalization, conflict detection
 * and one-row-per-track reduction before data crosses the process boundary.
 *
 * Keep buildDiscoveryTrackIdentityEvidence() below as the canonical pure
 * reducer used by unit tests and diagnostics. The SQL mirrors those rules:
 * ISRC removes non-ASCII alphanumerics before uppercasing, primary artist IDs
 * are trimmed, blank values are ignored, and conflicts mean >1 distinct
 * normalized non-null value.
 */
export async function getDiscoveryTrackIdentityEvidence(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DiscoveryTrackIdentityEvidence[]> {
  return client.$queryRawUnsafe<DiscoveryTrackIdentityEvidence[]>(
    `
      /* PERF-01: return one final identity-evidence row per Spotify track */
      WITH normalized AS (
        SELECT
          "spotifyTrackId",
          NULLIF(
            UPPER(
              regexp_replace(
                COALESCE("isrc", ''),
                '[^A-Za-z0-9]',
                '',
                'g'
              )
            ),
            ''
          ) AS "normalizedIsrc",
          NULLIF(BTRIM(COALESCE("primaryArtistId", '')), '')
            AS "normalizedPrimaryArtistId"
        FROM "TrackListeningEvent"
        WHERE "userId" = $1
          AND "spotifyTrackId" IS NOT NULL
      ), aggregated AS (
        SELECT
          "spotifyTrackId",
          COUNT(DISTINCT "normalizedIsrc")
            FILTER (WHERE "normalizedIsrc" IS NOT NULL) AS "isrcCount",
          MIN("normalizedIsrc") AS "singleIsrc",
          COUNT(DISTINCT "normalizedPrimaryArtistId")
            FILTER (WHERE "normalizedPrimaryArtistId" IS NOT NULL)
            AS "primaryArtistIdCount",
          MIN("normalizedPrimaryArtistId") AS "singlePrimaryArtistId"
        FROM normalized
        GROUP BY "spotifyTrackId"
      )
      SELECT
        "spotifyTrackId",
        CASE WHEN "isrcCount" = 1 THEN "singleIsrc" ELSE NULL END AS "isrc",
        CASE
          WHEN "primaryArtistIdCount" = 1 THEN "singlePrimaryArtistId"
          ELSE NULL
        END AS "primaryArtistId",
        ("isrcCount" > 1) AS "isrcConflict",
        ("primaryArtistIdCount" > 1) AS "primaryArtistIdConflict"
      FROM aggregated
      ORDER BY "spotifyTrackId" ASC
    `,
    userId,
  );
}

export function buildDiscoveryTrackIdentityEvidence(
  rows: DiscoveryTrackIdentityRow[],
): DiscoveryTrackIdentityEvidence[] {
  const byTrack = new Map<
    string,
    { isrcs: Set<string>; primaryArtistIds: Set<string> }
  >();

  for (const row of rows) {
    if (!row.spotifyTrackId) continue;
    let aggregate = byTrack.get(row.spotifyTrackId);
    if (!aggregate) {
      aggregate = { isrcs: new Set(), primaryArtistIds: new Set() };
      byTrack.set(row.spotifyTrackId, aggregate);
    }

    const isrc = normalizeIsrc(row.isrc);
    if (isrc) aggregate.isrcs.add(isrc);
    const primaryArtistId = row.primaryArtistId?.trim() || null;
    if (primaryArtistId) aggregate.primaryArtistIds.add(primaryArtistId);
  }

  return [...byTrack.entries()]
    .map(([spotifyTrackId, aggregate]) => ({
      spotifyTrackId,
      isrc: singleOrNull(aggregate.isrcs),
      primaryArtistId: singleOrNull(aggregate.primaryArtistIds),
      isrcConflict: aggregate.isrcs.size > 1,
      primaryArtistIdConflict: aggregate.primaryArtistIds.size > 1,
    }))
    .sort((a, b) => a.spotifyTrackId.localeCompare(b.spotifyTrackId));
}

function singleOrNull(values: Set<string>): string | null {
  if (values.size !== 1) return null;
  const value = values.values().next().value;
  return typeof value === "string" ? value : null;
}

function normalizeIsrc(value: string | null): string | null {
  const normalized = value?.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ?? "";
  return normalized || null;
}
