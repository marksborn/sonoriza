import { LikedTrackAvailability, NativeSourceType } from "@prisma/client";

import { spotifySavedTracksPlannerCapability } from "@/services/data-policy";
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
  /** Persisted consent exists independently from provider capability. */
  complianceBlocked?: boolean;
};

export const LIKED_TRACK_SOURCE_COMPLIANCE_REASON =
  "COMPLIANCE_SPOTIFY_SAVED_TRACKS_NOT_AUTHORIZED_FOR_PLANNER" as const;

/**
 * SOURCE-LIKED-01 Gate 5B1.
 *
 * Reads the product preference and lightweight source statistics exclusively
 * from Sonoriza-owned tables. It intentionally performs no provider read.
 *
 * This configuration surface is retained for transparency/audit. Its `enabled`
 * field is the user's persisted product choice, not proof that provider-derived
 * data is authorized for every possible downstream use.
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
 * SOURCE-LIKED-01 final direct-planner capability check.
 *
 * Saved Tracks keeps SPOTIFY lineage even when materialized locally. The final
 * #278 PERSONAL-mode decision explicitly reviewed this source for direct
 * operational planning + planner eligibility only. Analytics, profiling,
 * derived recommendation and AI remain separate blocked capabilities.
 */
export function isLikedTrackSourcePlannerUseAllowed(): boolean {
  return spotifySavedTracksPlannerCapability().allowed;
}

/**
 * SOURCE-LIKED-01 Gate 5B2 + final #278 policy.
 *
 * Reads only persisted product consent. Missing/unreadable state remains
 * fail-closed. Productive planner use also requires the narrow reviewed Saved
 * Tracks planner capability; no broader Spotify analytics/profile permission is
 * implied by this check.
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
    const explicitlyConfigured = Boolean(preference);

    if (!isLikedTrackSourcePlannerUseAllowed()) {
      return {
        enabled: false,
        explicitlyConfigured,
        readError: null,
        complianceBlocked: true,
      };
    }

    return {
      enabled: preference?.enabled ?? false,
      explicitlyConfigured,
      readError: null,
      complianceBlocked: false,
    };
  } catch (error) {
    return {
      enabled: false,
      explicitlyConfigured: false,
      readError: error instanceof Error ? error.message : String(error),
      complianceBlocked: false,
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
