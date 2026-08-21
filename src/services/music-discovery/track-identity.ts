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

export async function getDiscoveryTrackIdentityEvidence(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DiscoveryTrackIdentityEvidence[]> {
  // Duplicate listening events do not add any information to identity conflict
  // detection. Let PostgreSQL collapse identical identity triples before they
  // cross the process boundary so large histories do not materialize one Node
  // object per play just to be reduced back into Sets below.
  const rows = await client.trackListeningEvent.groupBy({
    by: ["spotifyTrackId", "isrc", "primaryArtistId"],
    where: { userId, spotifyTrackId: { not: null } },
  });

  return buildDiscoveryTrackIdentityEvidence(rows);
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
