import { LikedTrackAvailability, NativeSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { LIKED_TRACKS_NATIVE_SOURCE_KEY } from "./liked-track-source";

export type NativeLikedTrackSourceConfiguration = {
  key: typeof LIKED_TRACKS_NATIVE_SOURCE_KEY;
  type: typeof NativeSourceType.LIKED_TRACKS;
  kind: "MUSIC";
  semantics: "PERSISTENT_LIBRARY";
  enabled: boolean;
  explicitlyConfigured: boolean;
  counts: {
    activeLikedTracks: number;
    available: number;
    unavailable: number;
    invalid: number;
  };
  freshness: {
    latestObservedAt: Date | null;
  };
  providerReads: false;
  spotifyWrites: false;
  plannerInfluence: false;
};

export type NativeLikedTrackSourcePreferenceState = {
  enabled: boolean;
  explicitlyConfigured: boolean;
  readError: string | null;
};

/**
 * SOURCE-LIKED-01 Gate 5B1.
 *
 * Reads the product preference and lightweight source statistics exclusively
 * from Sonoriza-owned tables. It intentionally performs no provider read.
 */
export async function getNativeLikedTrackSourceConfiguration(
  userId: string,
): Promise<NativeLikedTrackSourceConfiguration> {
  const [preference, availabilityCounts, freshness] = await Promise.all([
    prisma.nativeSourcePreference.findUnique({
      where: {
        userId_type: {
          userId,
          type: NativeSourceType.LIKED_TRACKS,
        },
      },
      select: {
        enabled: true,
      },
    }),
    prisma.likedTrackPreference.groupBy({
      by: ["availability"],
      where: {
        userId,
        isLiked: true,
      },
      _count: {
        _all: true,
      },
    }),
    prisma.likedTrackPreference.aggregate({
      where: {
        userId,
        isLiked: true,
      },
      _max: {
        lastObservedAt: true,
      },
    }),
  ]);

  const countByAvailability = new Map(
    availabilityCounts.map((row) => [row.availability, row._count._all]),
  );
  const available = countByAvailability.get(LikedTrackAvailability.AVAILABLE) ?? 0;
  const unavailable = countByAvailability.get(LikedTrackAvailability.UNAVAILABLE) ?? 0;
  const invalid = countByAvailability.get(LikedTrackAvailability.INVALID) ?? 0;

  return {
    key: LIKED_TRACKS_NATIVE_SOURCE_KEY,
    type: NativeSourceType.LIKED_TRACKS,
    kind: "MUSIC",
    semantics: "PERSISTENT_LIBRARY",
    enabled: preference?.enabled ?? false,
    explicitlyConfigured: Boolean(preference),
    counts: {
      activeLikedTracks: available + unavailable + invalid,
      available,
      unavailable,
      invalid,
    },
    freshness: {
      latestObservedAt: freshness._max.lastObservedAt,
    },
    providerReads: false,
    spotifyWrites: false,
    plannerInfluence: false,
  };
}

/**
 * SOURCE-LIKED-01 Gate 5B2.
 *
 * Reads only the persisted product consent used by the planner gate. Missing or
 * unreadable state is fail-closed: the caller receives enabled=false and can
 * distinguish a normal opt-out from a database/read failure without consulting
 * Spotify or any provider.
 */
export async function getNativeLikedTrackSourcePreferenceState(
  userId: string,
): Promise<NativeLikedTrackSourcePreferenceState> {
  try {
    const preference = await prisma.nativeSourcePreference.findUnique({
      where: {
        userId_type: {
          userId,
          type: NativeSourceType.LIKED_TRACKS,
        },
      },
      select: {
        enabled: true,
      },
    });

    return {
      enabled: preference?.enabled ?? false,
      explicitlyConfigured: Boolean(preference),
      readError: null,
    };
  } catch (error) {
    return {
      enabled: false,
      explicitlyConfigured: false,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function setNativeLikedTrackSourceEnabled(
  userId: string,
  enabled: boolean,
) {
  return prisma.nativeSourcePreference.upsert({
    where: {
      userId_type: {
        userId,
        type: NativeSourceType.LIKED_TRACKS,
      },
    },
    create: {
      userId,
      type: NativeSourceType.LIKED_TRACKS,
      enabled,
    },
    update: {
      enabled,
    },
    select: {
      id: true,
      enabled: true,
      updatedAt: true,
    },
  });
}
