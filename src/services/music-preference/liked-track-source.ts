import { LikedTrackAvailability } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const LIKED_TRACKS_NATIVE_SOURCE_TYPE = "LIKED_TRACKS" as const;
export const LIKED_TRACKS_NATIVE_SOURCE_KEY = "native:liked-tracks" as const;

export const LIKED_TRACK_SOURCE_READINESS_LIMITS = {
  maxBlockedAvailableTracks: 25,
  maxBlockedAvailablePercent: 1,
} as const;

export type LikedTrackSourceRow = {
  spotifyTrackId: string;
  spotifyUri: string | null;
  trackName: string | null;
  primaryArtistId: string | null;
  primaryArtistName: string | null;
  albumId: string | null;
  albumName: string | null;
  durationMs: number | null;
  addedAt: Date | null;
  availability: LikedTrackAvailability;
  lastObservedAt: Date;
};

export type LikedTrackSourceSnapshot = {
  generatedAt: Date;
  source: {
    key: typeof LIKED_TRACKS_NATIVE_SOURCE_KEY;
    type: typeof LIKED_TRACKS_NATIVE_SOURCE_TYPE;
    kind: "MUSIC";
    persistence: "LIKED_TRACK_PREFERENCE";
    semantics: "PERSISTENT_LIBRARY";
    providerReads: false;
    spotifyWrites: false;
    plannerInfluence: false;
  };
  counts: {
    activeLikedTracks: number;
    available: number;
    unavailable: number;
    invalid: number;
    withUri: number;
    withTitle: number;
    withPrimaryArtist: number;
    withAlbum: number;
    withDuration: number;
    locallyMaterializedIdentity: number;
    plannerReadyAvailable: number;
  };
  freshness: {
    newestAddedAt: Date | null;
    oldestAddedAt: Date | null;
    latestObservedAt: Date | null;
  };
  plannerMaterialization: {
    ready: boolean;
    degraded: boolean;
    blocker:
      | "DURATION_INCOMPLETE"
      | "IDENTITY_INCOMPLETE"
      | "INCOMPLETE_TRACK_LIMIT_EXCEEDED"
      | null;
    requiredMissingField: "durationMs" | null;
    eligibleAvailableTracks: number;
    blockedAvailableTracks: number;
    blockedAvailablePercent: number;
    limits: typeof LIKED_TRACK_SOURCE_READINESS_LIMITS;
    blockedSample: Array<{
      spotifyTrackId: string;
      title: string | null;
      artist: string | null;
      missingFields: Array<"spotifyUri" | "trackName" | "durationMs">;
    }>;
    note: string;
  };
  sample: Array<{
    spotifyTrackId: string;
    uri: string | null;
    title: string | null;
    artist: string | null;
    album: string | null;
    durationMs: number | null;
    availability: LikedTrackAvailability;
  }>;
};

/**
 * SOURCE-LIKED-01 Gate 2/3A.
 *
 * Materializes the native LIKED_TRACKS source exclusively from Sonoriza-owned
 * LikedTrackPreference rows already reconciled by LIKED-01. This path is local
 * only: it performs no provider read, no Spotify write and remains disconnected
 * from the production planner.
 */
export async function getLikedTrackSourceSnapshot(
  userId: string,
): Promise<LikedTrackSourceSnapshot> {
  const rows = await prisma.likedTrackPreference.findMany({
    where: { userId, isLiked: true },
    select: {
      spotifyTrackId: true,
      spotifyUri: true,
      trackName: true,
      primaryArtistId: true,
      primaryArtistName: true,
      albumId: true,
      albumName: true,
      durationMs: true,
      addedAt: true,
      availability: true,
      lastObservedAt: true,
    },
    orderBy: [{ addedAt: "desc" }, { spotifyTrackId: "asc" }],
  });

  return buildLikedTrackSourceSnapshot(rows);
}

export function buildLikedTrackSourceSnapshot(
  rows: readonly LikedTrackSourceRow[],
  generatedAt = new Date(),
): LikedTrackSourceSnapshot {
  const available = rows.filter(
    (row) => row.availability === LikedTrackAvailability.AVAILABLE,
  );
  const identityReadyAvailable = available.filter(
    (row) =>
      Boolean(clean(row.spotifyUri)) &&
      Boolean(clean(row.trackName)) &&
      Boolean(clean(row.spotifyTrackId)),
  );
  const availableMissingDuration = available.filter(
    (row) => validDurationMs(row.durationMs) == null,
  );
  const plannerReadyAvailable = identityReadyAvailable.filter(
    (row) => validDurationMs(row.durationMs) != null,
  );
  const plannerReadyTrackIds = new Set(
    plannerReadyAvailable.map((row) => row.spotifyTrackId),
  );
  const blockedAvailable = available.filter(
    (row) => !plannerReadyTrackIds.has(row.spotifyTrackId),
  );
  const blockedAvailablePercent =
    available.length > 0 ? (blockedAvailable.length / available.length) * 100 : 0;
  const degraded =
    blockedAvailable.length > 0 &&
    plannerReadyAvailable.length > 0 &&
    blockedAvailable.length <=
      LIKED_TRACK_SOURCE_READINESS_LIMITS.maxBlockedAvailableTracks &&
    blockedAvailablePercent <=
      LIKED_TRACK_SOURCE_READINESS_LIMITS.maxBlockedAvailablePercent;
  const addedAt = rows
    .flatMap((row) => (row.addedAt ? [row.addedAt] : []))
    .sort((a, b) => a.getTime() - b.getTime());
  const observedAt = rows
    .map((row) => row.lastObservedAt)
    .sort((a, b) => a.getTime() - b.getTime());
  const ready =
    plannerReadyAvailable.length === available.length || degraded;

  return {
    generatedAt,
    source: {
      key: LIKED_TRACKS_NATIVE_SOURCE_KEY,
      type: LIKED_TRACKS_NATIVE_SOURCE_TYPE,
      kind: "MUSIC",
      persistence: "LIKED_TRACK_PREFERENCE",
      semantics: "PERSISTENT_LIBRARY",
      providerReads: false,
      spotifyWrites: false,
      plannerInfluence: false,
    },
    counts: {
      activeLikedTracks: rows.length,
      available: available.length,
      unavailable: rows.filter(
        (row) => row.availability === LikedTrackAvailability.UNAVAILABLE,
      ).length,
      invalid: rows.filter(
        (row) => row.availability === LikedTrackAvailability.INVALID,
      ).length,
      withUri: rows.filter((row) => Boolean(clean(row.spotifyUri))).length,
      withTitle: rows.filter((row) => Boolean(clean(row.trackName))).length,
      withPrimaryArtist: rows.filter(
        (row) => Boolean(clean(row.primaryArtistId) || clean(row.primaryArtistName)),
      ).length,
      withAlbum: rows.filter(
        (row) => Boolean(clean(row.albumId) || clean(row.albumName)),
      ).length,
      withDuration: rows.filter((row) => validDurationMs(row.durationMs) != null).length,
      locallyMaterializedIdentity: identityReadyAvailable.length,
      plannerReadyAvailable: plannerReadyAvailable.length,
    },
    freshness: {
      newestAddedAt: addedAt.at(-1) ?? null,
      oldestAddedAt: addedAt[0] ?? null,
      latestObservedAt: observedAt.at(-1) ?? null,
    },
    plannerMaterialization: {
      ready,
      degraded,
      blocker: ready
        ? null
        : blockedAvailable.length >
              LIKED_TRACK_SOURCE_READINESS_LIMITS.maxBlockedAvailableTracks ||
            blockedAvailablePercent >
              LIKED_TRACK_SOURCE_READINESS_LIMITS.maxBlockedAvailablePercent
          ? "INCOMPLETE_TRACK_LIMIT_EXCEEDED"
          : availableMissingDuration.length > 0
            ? "DURATION_INCOMPLETE"
            : identityReadyAvailable.length < available.length
              ? "IDENTITY_INCOMPLETE"
              : null,
      requiredMissingField:
        availableMissingDuration.length > 0 ? "durationMs" : null,
      eligibleAvailableTracks: plannerReadyAvailable.length,
      blockedAvailableTracks: blockedAvailable.length,
      blockedAvailablePercent,
      limits: LIKED_TRACK_SOURCE_READINESS_LIMITS,
      blockedSample: blockedAvailable.slice(0, 10).map((row) => ({
        spotifyTrackId: row.spotifyTrackId,
        title: clean(row.trackName),
        artist: clean(row.primaryArtistName),
        missingFields: [
          ...(!clean(row.spotifyUri) ? (["spotifyUri"] as const) : []),
          ...(!clean(row.trackName) ? (["trackName"] as const) : []),
          ...(validDurationMs(row.durationMs) == null
            ? (["durationMs"] as const)
            : []),
        ],
      })),
      note:
        blockedAvailable.length === 0
          ? "All currently available liked tracks have the local identity and duration required to become planner candidates."
          : degraded
            ? "A bounded number of incomplete available tracks was excluded locally; valid candidates remain eligible and no provider read is performed during generation."
            : "The native liked-track source is fail-closed because incomplete available tracks exceed the safe count or percentage limit.",
    },
    sample: rows.slice(0, 10).map((row) => ({
      spotifyTrackId: row.spotifyTrackId,
      uri: clean(row.spotifyUri),
      title: clean(row.trackName),
      artist: clean(row.primaryArtistName),
      album: clean(row.albumName),
      durationMs: validDurationMs(row.durationMs),
      availability: row.availability,
    })),
  };
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function validDurationMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
