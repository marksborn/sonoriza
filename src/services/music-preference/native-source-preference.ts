import { LikedTrackAvailability, NativeSourceType } from "@prisma/client";

import {
  lineageFromRootSource,
  policyDecisionForLineage,
} from "@/services/data-policy";
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
  /** Gate 5B: persisted consent exists independently from provider capability. */
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
 * field is the user's persisted product choice, not proof that Spotify-derived
 * data is currently authorized to influence the commercial planner.
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
 * Gate 5B capability check for the productive Saved Tracks source.
 *
 * Saved Tracks are Spotify-origin data even when materialized in a local table.
 * Local persistence and explicit user consent do not launder that origin. The
 * productive planner requires both RECOMMENDATION and PLANNER_ELIGIBILITY to be
 * explicitly ALLOW; REVIEW_REQUIRED is fail-closed.
 */
export function isLikedTrackSourcePlannerUseAllowed(): boolean {
  const lineage = lineageFromRootSource("SPOTIFY_SAVED_TRACKS");
  return (
    policyDecisionForLineage(lineage, "RECOMMENDATION") === "ALLOW" &&
    policyDecisionForLineage(lineage, "PLANNER_ELIGIBILITY") === "ALLOW"
  );
}

/**
 * SOURCE-LIKED-01 Gate 5B2 + SPOTIFY-COMPLIANCE-01 Gate 5B.
 *
 * Reads only persisted product consent. Missing/unreadable state remains
 * fail-closed. Even when the user explicitly enabled this source, the returned
 * planner state is forced disabled while Spotify Saved Tracks lacks productive
 * capability. This keeps the user's stored preference intact for audit and a
 * future policy change without allowing provider-derived data into planning.
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
