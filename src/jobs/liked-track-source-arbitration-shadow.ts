import {
  planRun,
  type Candidate,
  type PlanRunResult,
  type PlannerPools,
  type RunTarget,
} from "@/services/playlist-planner";

import type {
  LikedTrackSourceShadowContext,
  PreparedLikedTrackSourceShadow,
} from "./liked-track-source-shadow";

export const LIKED_TRACK_SOURCE_ARBITRATION_SHADOW = {
  version: "source-liked-gate3c-v1",
  mode: "SHADOW_ONLY",
  exposures: [5, 10, 20] as const,
  strategy: "ORDER_PRESERVING_INTERLEAVE_EXCLUSIVE_LIKED",
  plannerInfluence: false,
} as const;

export type LikedTrackArbitrationShadowEvidence = {
  policyVersion: string;
  mode: "SHADOW_ONLY";
  strategy: string;
  plannerInfluence: false;
  exposures: number[];
  currentRepresentation: Array<Record<string, unknown>>;
  variants: Array<Record<string, unknown>>;
};

/**
 * SOURCE-LIKED-01 Gate 3C.
 *
 * Measures how many liked tracks are already present in the authoritative plan
 * and compares bounded interleaving scenarios. Every plan produced here is
 * hypothetical: callers keep the original plan authoritative.
 */
export function buildLikedTrackArbitrationShadowEvidence(input: {
  prepared: PreparedLikedTrackSourceShadow;
  context: LikedTrackSourceShadowContext;
}): LikedTrackArbitrationShadowEvidence {
  const { prepared, context } = input;
  const likedUris = new Set(prepared.candidates.map((candidate) => candidate.uri));
  const initialReserved = context.initialReserved
    ? [...context.initialReserved]
    : undefined;

  const currentRepresentation = context.plan.targets.map((planned) => {
    const likedSelected = planned.result.items.filter(
      (item) => item.type === "MUSIC" && likedUris.has(item.uri),
    );
    return {
      targetPlaylistId: planned.targetPlaylistId,
      targetName: planned.name,
      allowlisted: prepared.targetIds.has(planned.targetPlaylistId),
      selectedMusicCount: planned.result.stats.musicCount,
      selectedLikedCount: likedSelected.length,
      selectedLikedPercentOfMusic: percent(
        likedSelected.length,
        planned.result.stats.musicCount,
      ),
      selectedLikedSample: sample(likedSelected),
    };
  });

  const variants = LIKED_TRACK_SOURCE_ARBITRATION_SHADOW.exposures.map(
    (exposurePercent) =>
      buildVariant({
        prepared,
        context,
        likedUris,
        initialReserved,
        exposurePercent,
      }),
  );

  return {
    policyVersion: LIKED_TRACK_SOURCE_ARBITRATION_SHADOW.version,
    mode: LIKED_TRACK_SOURCE_ARBITRATION_SHADOW.mode,
    strategy: LIKED_TRACK_SOURCE_ARBITRATION_SHADOW.strategy,
    plannerInfluence: false,
    exposures: [...LIKED_TRACK_SOURCE_ARBITRATION_SHADOW.exposures],
    currentRepresentation,
    variants,
  };
}

function buildVariant(input: {
  prepared: PreparedLikedTrackSourceShadow;
  context: LikedTrackSourceShadowContext;
  likedUris: ReadonlySet<string>;
  initialReserved?: readonly string[];
  exposurePercent: number;
}): Record<string, unknown> {
  const {
    prepared,
    context,
    likedUris,
    initialReserved,
    exposurePercent,
  } = input;
  const variantMusicPoolByTargetId = new Map<string, Candidate[]>();
  const exclusiveLikedUrisByTargetId = new Map<string, Set<string>>();
  const targetInputs: Array<Record<string, unknown>> = [];

  for (const target of context.targets) {
    const currentPool =
      context.musicPoolByTargetId?.get(target.targetPlaylistId) ?? context.pools.music;
    const currentUris = new Set(currentPool.map((candidate) => candidate.uri));
    const allowlisted = prepared.targetIds.has(target.targetPlaylistId);
    const blocked = context.blockedMusicTrackIdsByTargetId?.get(
      target.targetPlaylistId,
    );
    const exclusiveBeforeNegative = allowlisted
      ? prepared.candidates.filter((candidate) => !currentUris.has(candidate.uri))
      : [];
    const exclusiveEligible = exclusiveBeforeNegative.filter(
      (candidate) =>
        !candidate.spotifyTrackId || !blocked?.has(candidate.spotifyTrackId),
    );
    const exclusiveLikedUris = new Set(
      exclusiveEligible.map((candidate) => candidate.uri),
    );
    exclusiveLikedUrisByTargetId.set(target.targetPlaylistId, exclusiveLikedUris);

    const variantPool = allowlisted
      ? interleaveExclusiveLiked(currentPool, exclusiveEligible, exposurePercent)
      : [...currentPool];
    variantMusicPoolByTargetId.set(target.targetPlaylistId, variantPool);

    targetInputs.push({
      targetPlaylistId: target.targetPlaylistId,
      targetName: target.name,
      allowlisted,
      exposurePercent,
      currentMusicPoolCount: currentPool.length,
      exclusiveLikedBeforeNegative: exclusiveBeforeNegative.length,
      exclusiveLikedEligible: exclusiveEligible.length,
      negativeSignalBlocked:
        exclusiveBeforeNegative.length - exclusiveEligible.length,
      variantMusicPoolCount: variantPool.length,
    });
  }

  const shadowPools: PlannerPools = {
    ...context.pools,
    music: dedupeByUri([...context.pools.music, ...prepared.candidates]),
  };
  const shadowPlan = planRun({
    pools: shadowPools,
    targets: context.targets,
    musicPoolByTargetId: variantMusicPoolByTargetId,
    preservedByTargetId: context.preservedByTargetId,
    blockedMusicTrackIdsByTargetId: context.blockedMusicTrackIdsByTargetId,
    initialReserved,
  });

  const targets = context.plan.targets.map((currentTarget) => {
    const shadowTarget = shadowPlan.targets.find(
      (target) => target.targetPlaylistId === currentTarget.targetPlaylistId,
    );
    if (!shadowTarget) {
      return {
        targetPlaylistId: currentTarget.targetPlaylistId,
        targetName: currentTarget.name,
        shadowMissing: true,
      };
    }

    const currentUris = new Set(currentTarget.result.items.map((item) => item.uri));
    const shadowUris = new Set(shadowTarget.result.items.map((item) => item.uri));
    const currentLiked = currentTarget.result.items.filter(
      (item) => item.type === "MUSIC" && likedUris.has(item.uri),
    );
    const shadowLiked = shadowTarget.result.items.filter(
      (item) => item.type === "MUSIC" && likedUris.has(item.uri),
    );
    const exclusiveLikedUris =
      exclusiveLikedUrisByTargetId.get(currentTarget.targetPlaylistId) ?? new Set();
    const exclusiveSelected = shadowTarget.result.items.filter((item) =>
      exclusiveLikedUris.has(item.uri),
    );

    return {
      targetPlaylistId: currentTarget.targetPlaylistId,
      targetName: currentTarget.name,
      allowlisted: prepared.targetIds.has(currentTarget.targetPlaylistId),
      exposurePercent,
      current: compactStats(currentTarget.result),
      shadow: compactStats(shadowTarget.result),
      currentLikedSelectedCount: currentLiked.length,
      shadowLikedSelectedCount: shadowLiked.length,
      deltaLikedSelected: shadowLiked.length - currentLiked.length,
      shadowLikedPercentOfMusic: percent(
        shadowLiked.length,
        shadowTarget.result.stats.musicCount,
      ),
      exclusiveLikedSelectedCount: exclusiveSelected.length,
      exclusiveLikedSelectedSample: sample(exclusiveSelected),
      selectedAddedVsCurrent: [...shadowUris].filter((uri) => !currentUris.has(uri))
        .length,
      selectedRemovedVsCurrent: [...currentUris].filter((uri) => !shadowUris.has(uri))
        .length,
      durationDeltaMs:
        shadowTarget.result.stats.totalDurationMs -
        currentTarget.result.stats.totalDurationMs,
      distinctArtistDelta:
        shadowTarget.result.stats.distinctArtistCount -
        currentTarget.result.stats.distinctArtistCount,
      distinctAlbumDelta:
        shadowTarget.result.stats.distinctAlbumCount -
        currentTarget.result.stats.distinctAlbumCount,
      compositionQualityPreserved:
        shadowTarget.result.stats.compositionQualityPassed ===
        currentTarget.result.stats.compositionQualityPassed,
      sequenceQualityPreserved:
        shadowTarget.result.stats.sequenceQualityPassed ===
        currentTarget.result.stats.sequenceQualityPassed,
    };
  });

  return {
    exposurePercent,
    targetInputs,
    targets,
  };
}

export function interleaveExclusiveLiked(
  currentPool: readonly Candidate[],
  exclusiveLiked: readonly Candidate[],
  exposurePercent: number,
): Candidate[] {
  if (exclusiveLiked.length === 0 || exposurePercent <= 0) {
    return dedupeByUri(currentPool);
  }
  const bounded = Math.max(1, Math.min(50, Math.round(exposurePercent)));
  const currentPerLiked = Math.max(1, Math.round((100 - bounded) / bounded));
  const output: Candidate[] = [];
  let currentIndex = 0;
  let likedIndex = 0;

  while (currentIndex < currentPool.length || likedIndex < exclusiveLiked.length) {
    for (
      let count = 0;
      count < currentPerLiked && currentIndex < currentPool.length;
      count += 1
    ) {
      output.push(currentPool[currentIndex]!);
      currentIndex += 1;
    }
    if (likedIndex < exclusiveLiked.length) {
      output.push(exclusiveLiked[likedIndex]!);
      likedIndex += 1;
    } else if (currentIndex >= currentPool.length) {
      break;
    }
  }

  return dedupeByUri(output);
}

function compactStats(result: PlanRunResult["targets"][number]["result"]) {
  return {
    itemCount: result.items.length,
    musicCount: result.stats.musicCount,
    podcastCount: result.stats.podcastCount,
    totalDurationMs: result.stats.totalDurationMs,
    musicDurationMs: result.stats.musicDurationMs,
    podcastDurationMs: result.stats.podcastDurationMs,
    compositionQualityPassed: result.stats.compositionQualityPassed,
    sequenceQualityPassed: result.stats.sequenceQualityPassed,
    distinctArtistCount: result.stats.distinctArtistCount,
    distinctAlbumCount: result.stats.distinctAlbumCount,
    artistLimitRejectedCount: result.stats.artistLimitRejectedCount,
    albumLimitRejectedCount: result.stats.albumLimitRejectedCount,
    unfilledSlots: result.stats.unfilledSlots,
    poolExhausted: result.stats.poolExhausted,
  };
}

function sample(
  items: readonly PlanRunResult["targets"][number]["result"]["items"][number][],
) {
  return items.slice(0, 10).map((item) => ({
    spotifyTrackId: item.spotifyTrackId ?? null,
    uri: item.uri,
    title: item.title,
    artist: item.primaryArtistName ?? null,
    durationMs: item.durationMs,
  }));
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

function dedupeByUri(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.uri || seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    result.push(candidate);
  }
  return result;
}
