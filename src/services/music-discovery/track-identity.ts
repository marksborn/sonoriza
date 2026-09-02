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
 * Gate 5A compliance boundary.
 *
 * The historical identity reducer used to read every TrackListeningEvent and
 * turn provider history into ISRC/primary-artist identity evidence consumed by
 * productive discovery scoring. The current TrackListeningEvent source model
 * has no first-party source whose lineage is ALLOW for recommendation; Spotify
 * is DENY and Last.fm/import remain REVIEW_REQUIRED under Gate 2.
 *
 * Until identity evidence has row-level provenance that can be filtered before
 * aggregation, fail closed and do not query the historical table at all. This
 * avoids a second provider-history path around the guarded COMPLETE profile.
 * The pure reducer below remains available for deterministic/domain tests and
 * for a future explicitly eligible source.
 */
export async function getDiscoveryTrackIdentityEvidence(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DiscoveryTrackIdentityEvidence[]> {
  void userId;
  void client;
  return [];
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
