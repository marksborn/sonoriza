import { prisma } from "@/lib/prisma";
import {
  readSpotifyLikedTrackInventory,
  type SpotifyLikedTrackInventory,
} from "@/services/music-preference/liked-track-inventory";
import { getSpotifyAccessToken } from "@/services/spotify/token";

export type LikedTrackDurationSyncMode = "PREVIEW" | "APPLY";

export type ExistingLikedTrackDuration = {
  spotifyTrackId: string;
  durationMs: number | null;
  isLiked: boolean;
};

export type LikedTrackDurationUpdate = {
  spotifyTrackId: string;
  durationMs: number;
};

export type LikedTrackDurationPlan = {
  providerCanonicalTracks: number;
  providerTracksWithDuration: number;
  activeLikedTracks: number;
  beforeWithDuration: number;
  updates: LikedTrackDurationUpdate[];
  unchangedWithDuration: number;
  missingProviderTrack: number;
  missingProviderDuration: number;
  afterWithDuration: number;
  coveragePercent: number;
};

export type LikedTrackDurationSyncReport = {
  generatedAt: Date;
  mode: LikedTrackDurationSyncMode;
  provider: {
    rows: number;
    pagesRead: number;
    providerCalls: number;
    retries: number;
    rateLimitedCount: number;
    retryWaitMs: number;
    canonicalTracks: number;
    tracksWithDuration: number;
  };
  local: {
    activeLikedTracks: number;
    beforeWithDuration: number;
    updatesPlanned: number;
    unchangedWithDuration: number;
    missingProviderTrack: number;
    missingProviderDuration: number;
    afterWithDuration: number;
    coveragePercent: number;
  };
  plannerInfluence: false;
  spotifyWrites: false;
};

/**
 * SOURCE-LIKED-01 Gate 3A.
 *
 * Backfills durationMs into the canonical LikedTrackPreference state. Spotify
 * is read only; the only APPLY write is the local durationMs column. The source
 * remains disconnected from the planner in this gate.
 */
export async function syncLikedTrackDuration(
  userId: string,
  options: { mode?: LikedTrackDurationSyncMode } = {},
): Promise<LikedTrackDurationSyncReport> {
  const mode = options.mode ?? "PREVIEW";
  const generatedAt = new Date();
  const accessToken = await getSpotifyAccessToken(userId);
  const provider = await readSpotifyLikedTrackInventory(accessToken);
  const existing = await prisma.likedTrackPreference.findMany({
    where: { userId },
    select: {
      spotifyTrackId: true,
      durationMs: true,
      isLiked: true,
    },
  });

  const plan = buildLikedTrackDurationPlan(provider, existing);

  if (mode === "APPLY" && plan.updates.length > 0) {
    for (const batch of chunks(plan.updates, 50)) {
      await Promise.all(
        batch.map((update) =>
          prisma.likedTrackPreference.updateMany({
            where: {
              userId,
              spotifyTrackId: update.spotifyTrackId,
              isLiked: true,
            },
            data: { durationMs: update.durationMs },
          }),
        ),
      );
    }
  }

  return buildLikedTrackDurationSyncReport(provider, plan, mode, generatedAt);
}

export function buildLikedTrackDurationPlan(
  provider: SpotifyLikedTrackInventory,
  existing: readonly ExistingLikedTrackDuration[],
): LikedTrackDurationPlan {
  const providerByTrackId = new Map<string, number | null>();
  for (const item of provider.items) {
    const trackId = clean(item.spotifyTrackId);
    if (!trackId) continue;
    const durationMs = validDurationMs(item.durationMs);
    const previous = providerByTrackId.get(trackId);
    if (previous == null || durationMs != null) {
      providerByTrackId.set(trackId, durationMs);
    }
  }

  const active = existing.filter((row) => row.isLiked);
  const updates: LikedTrackDurationUpdate[] = [];
  let beforeWithDuration = 0;
  let afterWithDuration = 0;
  let unchangedWithDuration = 0;
  let missingProviderTrack = 0;
  let missingProviderDuration = 0;

  for (const row of active) {
    const currentDuration = validDurationMs(row.durationMs);
    if (currentDuration != null) beforeWithDuration += 1;

    const providerHasTrack = providerByTrackId.has(row.spotifyTrackId);
    const providerDuration = providerHasTrack
      ? (providerByTrackId.get(row.spotifyTrackId) ?? null)
      : null;

    // APPLY only replaces duration when the provider supplies a valid value.
    // Otherwise the currently valid local duration, when present, survives.
    if (providerDuration != null || currentDuration != null) {
      afterWithDuration += 1;
    }

    if (!providerHasTrack) {
      missingProviderTrack += 1;
      continue;
    }

    if (providerDuration == null) {
      missingProviderDuration += 1;
      continue;
    }

    if (currentDuration === providerDuration) {
      unchangedWithDuration += 1;
      continue;
    }

    updates.push({
      spotifyTrackId: row.spotifyTrackId,
      durationMs: providerDuration,
    });
  }

  updates.sort((left, right) => left.spotifyTrackId.localeCompare(right.spotifyTrackId));

  return {
    providerCanonicalTracks: providerByTrackId.size,
    providerTracksWithDuration: [...providerByTrackId.values()].filter(
      (durationMs) => durationMs != null,
    ).length,
    activeLikedTracks: active.length,
    beforeWithDuration,
    updates,
    unchangedWithDuration,
    missingProviderTrack,
    missingProviderDuration,
    afterWithDuration,
    coveragePercent:
      active.length === 0 ? 100 : Number(((afterWithDuration / active.length) * 100).toFixed(2)),
  };
}

function buildLikedTrackDurationSyncReport(
  provider: SpotifyLikedTrackInventory,
  plan: LikedTrackDurationPlan,
  mode: LikedTrackDurationSyncMode,
  generatedAt: Date,
): LikedTrackDurationSyncReport {
  return {
    generatedAt,
    mode,
    provider: {
      rows: provider.items.length,
      pagesRead: provider.pagesRead,
      providerCalls: provider.providerCalls,
      retries: provider.retries,
      rateLimitedCount: provider.rateLimitedCount,
      retryWaitMs: provider.retryWaitMs,
      canonicalTracks: plan.providerCanonicalTracks,
      tracksWithDuration: plan.providerTracksWithDuration,
    },
    local: {
      activeLikedTracks: plan.activeLikedTracks,
      beforeWithDuration: plan.beforeWithDuration,
      updatesPlanned: plan.updates.length,
      unchangedWithDuration: plan.unchangedWithDuration,
      missingProviderTrack: plan.missingProviderTrack,
      missingProviderDuration: plan.missingProviderDuration,
      afterWithDuration: plan.afterWithDuration,
      coveragePercent: plan.coveragePercent,
    },
    plannerInfluence: false,
    spotifyWrites: false,
  };
}

function validDurationMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
