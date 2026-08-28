import { LikedTrackAvailability } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildLikedTrackSourceSnapshot } from "@/services/music-preference/liked-track-source";
import {
  planRun,
  type Candidate,
  type PlanRunResult,
  type PlannerPools,
  type RunTarget,
} from "@/services/playlist-planner";
import { filterMusicCandidatesForRepeat } from "@/services/spotify/recently-played";

import {
  buildLikedTrackArbitrationShadowEvidence,
  interleaveExclusiveLiked,
} from "./liked-track-source-arbitration-shadow";
import { currentMusicRepeatState } from "./music-repeat-runtime";

export const LIKED_TRACK_SOURCE_SHADOW_POLICY = {
  version: "source-liked-gate3b-v1",
  mode: "SHADOW_ONLY",
  activationRule: "MASTER_FLAG_AND_USER_ALLOWLIST_AND_TARGET_ID_ALLOWLIST",
  arbitration: "APPEND_AFTER_CURRENT_TARGET_MUSIC_POOL",
  fallbackRule: "ABSTAIN_AND_KEEP_CURRENT_PLAN",
  persistenceRule: "GENERATION_SUMMARY_ONLY",
} as const;

/**
 * SOURCE-LIKED-01 Gate 5A.
 *
 * The first productive rollout deliberately reuses the 5% arbitration that was
 * already measured in Gate 3C. It only replaces a plan that was already ready,
 * and it abstains if any non-allowlisted target moves or if an allowlisted
 * target regresses on quality, duration or diversity. The source is local-only;
 * this gate never performs provider reads to build its candidate set.
 */
export const LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY = {
  version: "source-liked-gate5a-v1",
  mode: "PILOT_PRODUCTIVE",
  exposurePercent: 5,
  activationRule: "MASTER_FLAG_AND_USER_ALLOWLIST_AND_TARGET_ID_ALLOWLIST",
  strategy: "ORDER_PRESERVING_INTERLEAVE_EXCLUSIVE_LIKED",
  fallbackRule: "ABSTAIN_AND_KEEP_READY_BASELINE_PLAN",
  providerReads: false,
} as const;

export type LikedTrackSourceShadowPolicyReason =
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "TARGET_ALLOWLIST_EMPTY"
  | "ENABLED";

export type LikedTrackSourceShadowContext = {
  pools: PlannerPools;
  plan: PlanRunResult;
  targets: RunTarget[];
  musicPoolByTargetId?: ReadonlyMap<string, Candidate[]>;
  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;
  blockedMusicTrackIdsByTargetId?: ReadonlyMap<string, ReadonlySet<string>>;
  initialReserved?: Iterable<string>;
};

export type PreparedLikedTrackSourceShadow = {
  enabled: boolean;
  targetIds: ReadonlySet<string>;
  candidates: Candidate[];
  /** Gate 5A pilot is independent from the shadow flag. Optional keeps Gate 3 tests/source compatible. */
  plannerPilotEnabled?: boolean;
  plannerPilotTargetIds?: ReadonlySet<string>;
};

export type LikedTrackProductivePilotProposal = {
  plan: PlanRunResult;
  safe: boolean;
  changed: boolean;
  guardFailures: Array<Record<string, unknown>>;
  targetInputs: Array<Record<string, unknown>>;
  targets: Array<Record<string, unknown>>;
};

export function resolveLikedTrackSourceShadowPolicy(input: {
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  allowlistedTargetIds?: string | null;
}): {
  enabled: boolean;
  reason: LikedTrackSourceShadowPolicyReason;
  targetIds: ReadonlySet<string>;
} {
  return resolveAllowlistedPolicy(input);
}

export function resolveLikedTrackSourcePlannerPilotPolicy(input: {
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  allowlistedTargetIds?: string | null;
}): {
  enabled: boolean;
  reason: LikedTrackSourceShadowPolicyReason;
  targetIds: ReadonlySet<string>;
} {
  return resolveAllowlistedPolicy(input);
}

/**
 * SOURCE-LIKED-01 Gate 3B/3C + Gate 5A preparation.
 *
 * One local DB read serves shadow and productive pilot policies. Neither policy
 * needs Spotify reads here. A disabled/not-ready/error state always abstains.
 */
export async function prepareLikedTrackSourceShadowForCurrentRun(): Promise<PreparedLikedTrackSourceShadow> {
  const runState = currentMusicRepeatState();
  if (!runState) {
    return emptyPrepared();
  }

  const base = summaryBase();
  runState.likedTrackSourceShadow = base;

  try {
    const user = await prisma.user.findUnique({
      where: { id: runState.userId },
      select: { email: true },
    });
    const shadowPolicy = resolveLikedTrackSourceShadowPolicy({
      userEmail: user?.email,
      masterEnabled: process.env.LIKED_TRACK_SOURCE_SHADOW_ENABLED,
      allowlistedEmails: process.env.LIKED_TRACK_SOURCE_SHADOW_USER_EMAILS,
      allowlistedTargetIds: process.env.LIKED_TRACK_SOURCE_SHADOW_TARGET_IDS,
    });
    const plannerPilotPolicy = resolveLikedTrackSourcePlannerPilotPolicy({
      userEmail: user?.email,
      masterEnabled: process.env.LIKED_TRACK_SOURCE_PLANNER_ENABLED,
      allowlistedEmails: process.env.LIKED_TRACK_SOURCE_PLANNER_USER_EMAILS,
      allowlistedTargetIds: process.env.LIKED_TRACK_SOURCE_PLANNER_TARGET_IDS,
    });

    runState.likedTrackSourceShadow = {
      ...base,
      policyEnabled: shadowPolicy.enabled,
      policyReason: shadowPolicy.reason,
      userAllowlisted:
        shadowPolicy.reason !== "USER_NOT_ALLOWLISTED" && Boolean(user?.email),
      targetAllowlist: [...shadowPolicy.targetIds],
      productivePilot: productivePilotSummaryBase({
        enabled: plannerPilotPolicy.enabled,
        reason: plannerPilotPolicy.reason,
        targetIds: plannerPilotPolicy.targetIds,
      }),
    };

    if (!shadowPolicy.enabled && !plannerPilotPolicy.enabled) {
      return {
        enabled: false,
        targetIds: shadowPolicy.targetIds,
        candidates: [],
        plannerPilotEnabled: false,
        plannerPilotTargetIds: plannerPilotPolicy.targetIds,
      };
    }

    const rows = await prisma.likedTrackPreference.findMany({
      where: { userId: runState.userId, isLiked: true },
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
    const snapshot = buildLikedTrackSourceSnapshot(rows);
    const candidates = buildLikedTrackShadowCandidates(rows);
    const repeat = filterMusicCandidatesForRepeat(candidates, runState.context);
    const sourceReady = snapshot.plannerMaterialization.ready;

    const existingProductive = productivePilotSummary(
      runState.likedTrackSourceShadow,
    );
    runState.likedTrackSourceShadow = {
      ...(runState.likedTrackSourceShadow ?? base),
      sourceReady,
      likedSourceTrackCount: snapshot.counts.activeLikedTracks,
      likedSourceResolvedCount: snapshot.counts.plannerReadyAvailable,
      likedSourceUnavailableCount: snapshot.counts.unavailable,
      likedSourceCandidatesRead: candidates.length,
      likedSourceCacheHits: candidates.length,
      likedSourceProviderCalls: 0,
      repeatEligibleCandidates: repeat.candidates.length,
      repeatBlockedCandidates: repeat.recentlyPlayedSkippedCount,
      missingTrackIdentityCandidates: repeat.missingTrackIdentitySkippedCount,
      sourceBlocker: snapshot.plannerMaterialization.blocker,
      attempted: false,
      reason: shadowPolicy.enabled
        ? sourceReady
          ? "READY_FOR_SHADOW_COMPARISON"
          : "SOURCE_NOT_READY"
        : shadowPolicy.reason,
      productivePilot: {
        ...existingProductive,
        sourceReady,
        sourceBlocker: snapshot.plannerMaterialization.blocker,
        likedSourceTrackCount: snapshot.counts.activeLikedTracks,
        likedSourceResolvedCount: snapshot.counts.plannerReadyAvailable,
        likedSourceUnavailableCount: snapshot.counts.unavailable,
        likedSourceCandidatesRead: candidates.length,
        likedSourceProviderCalls: 0,
        repeatEligibleCandidates: repeat.candidates.length,
        repeatBlockedCandidates: repeat.recentlyPlayedSkippedCount,
        missingTrackIdentityCandidates: repeat.missingTrackIdentitySkippedCount,
        status: plannerPilotPolicy.enabled
          ? sourceReady
            ? "READY"
            : "SOURCE_NOT_READY"
          : "DISABLED",
        reason: plannerPilotPolicy.enabled
          ? sourceReady
            ? "READY_FOR_PRODUCTIVE_PILOT"
            : "SOURCE_NOT_READY"
          : plannerPilotPolicy.reason,
      },
    };

    if (!sourceReady) {
      return {
        enabled: false,
        targetIds: shadowPolicy.targetIds,
        candidates: [],
        plannerPilotEnabled: false,
        plannerPilotTargetIds: plannerPilotPolicy.targetIds,
      };
    }

    return {
      enabled: shadowPolicy.enabled,
      targetIds: shadowPolicy.targetIds,
      candidates: repeat.candidates,
      plannerPilotEnabled: plannerPilotPolicy.enabled,
      plannerPilotTargetIds: plannerPilotPolicy.targetIds,
    };
  } catch (error) {
    runState.likedTrackSourceShadow = {
      ...base,
      status: "ERROR",
      reason: "SOURCE_PREPARATION_FAILED",
      error: error instanceof Error ? error.message : String(error),
      productivePilot: {
        ...productivePilotSummaryBase({
          enabled: false,
          reason: "MASTER_DISABLED",
          targetIds: new Set(),
        }),
        status: "ERROR",
        reason: "SOURCE_PREPARATION_FAILED",
        error: error instanceof Error ? error.message : String(error),
      },
    };
    return emptyPrepared();
  }
}

export function applyLikedTrackSourceShadowForCurrentRun(
  prepared: PreparedLikedTrackSourceShadow,
  context: LikedTrackSourceShadowContext,
): void {
  const runState = currentMusicRepeatState();
  if (!runState || (!prepared.enabled && !prepared.plannerPilotEnabled)) return;

  // Capture shadow evidence against the untouched authoritative baseline first.
  if (prepared.enabled) {
    captureShadowEvidence(prepared, context);
  }

  if (prepared.plannerPilotEnabled) {
    applyProductivePilot(prepared, context);
  }
}

function captureShadowEvidence(
  prepared: PreparedLikedTrackSourceShadow,
  context: LikedTrackSourceShadowContext,
): void {
  const runState = currentMusicRepeatState();
  if (!runState) return;

  try {
    const allowedTargets = context.targets.filter((target) =>
      prepared.targetIds.has(target.targetPlaylistId),
    );
    if (allowedTargets.length === 0) {
      runState.likedTrackSourceShadow = {
        ...(runState.likedTrackSourceShadow ?? summaryBase()),
        attempted: false,
        reason: "NO_ALLOWLISTED_TARGET_IN_RUN",
      };
      return;
    }

    const currentFingerprint = planFingerprint(context.plan);
    const shadowMusicPoolByTargetId = new Map<string, Candidate[]>();
    const sourceAddedUrisByTargetId = new Map<string, Set<string>>();
    const targetInputs: Array<Record<string, unknown>> = [];

    for (const target of context.targets) {
      const currentPool =
        context.musicPoolByTargetId?.get(target.targetPlaylistId) ??
        context.pools.music;
      const currentUris = new Set(currentPool.map((candidate) => candidate.uri));
      const allowlisted = prepared.targetIds.has(target.targetPlaylistId);
      const blocked = context.blockedMusicTrackIdsByTargetId?.get(
        target.targetPlaylistId,
      );
      const sourceNew = allowlisted
        ? prepared.candidates.filter((candidate) => !currentUris.has(candidate.uri))
        : [];
      const sourceAddedUris = new Set(sourceNew.map((candidate) => candidate.uri));
      sourceAddedUrisByTargetId.set(target.targetPlaylistId, sourceAddedUris);
      shadowMusicPoolByTargetId.set(
        target.targetPlaylistId,
        dedupeByUri([...currentPool, ...sourceNew]),
      );

      const overlap = allowlisted
        ? prepared.candidates.filter((candidate) => currentUris.has(candidate.uri))
            .length
        : 0;
      const negativeBlocked = allowlisted
        ? sourceNew.filter(
            (candidate) =>
              Boolean(candidate.spotifyTrackId) &&
              Boolean(
                candidate.spotifyTrackId && blocked?.has(candidate.spotifyTrackId),
              ),
          ).length
        : 0;
      targetInputs.push({
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        allowlisted,
        currentMusicPoolCount: currentPool.length,
        likedCandidateCount: allowlisted ? prepared.candidates.length : 0,
        overlapCurrentPool: overlap,
        newToCurrentPool: sourceNew.length,
        negativeSignalBlocked: negativeBlocked,
        survivingBeforePlanner: Math.max(0, sourceNew.length - negativeBlocked),
      });
    }

    const shadowPools: PlannerPools = {
      ...context.pools,
      music: dedupeByUri([...context.pools.music, ...prepared.candidates]),
    };
    const shadowPlan = planRun({
      pools: shadowPools,
      targets: context.targets,
      musicPoolByTargetId: shadowMusicPoolByTargetId,
      preservedByTargetId: context.preservedByTargetId,
      blockedMusicTrackIdsByTargetId: context.blockedMusicTrackIdsByTargetId,
      initialReserved: context.initialReserved,
    });

    const comparisons = context.plan.targets.map((currentTarget) => {
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
      const sourceUris =
        sourceAddedUrisByTargetId.get(currentTarget.targetPlaylistId) ?? new Set();
      const selectedFromLiked = shadowTarget.result.items.filter((item) =>
        sourceUris.has(item.uri),
      );
      const currentUris = new Set(
        currentTarget.result.items.map((item) => item.uri),
      );
      const shadowUris = new Set(shadowTarget.result.items.map((item) => item.uri));
      return {
        targetPlaylistId: currentTarget.targetPlaylistId,
        targetName: currentTarget.name,
        allowlisted: prepared.targetIds.has(currentTarget.targetPlaylistId),
        current: compactStats(currentTarget.result),
        shadow: compactStats(shadowTarget.result),
        likedSourceCandidatesSelected: selectedFromLiked.length,
        likedSourceSelectedSample: selectedFromLiked.slice(0, 10).map(sampleItem),
        selectedAddedVsCurrent: [...shadowUris].filter(
          (uri) => !currentUris.has(uri),
        ).length,
        selectedRemovedVsCurrent: [...currentUris].filter(
          (uri) => !shadowUris.has(uri),
        ).length,
      };
    });

    let arbitrationShadow: Record<string, unknown>;
    try {
      arbitrationShadow = buildLikedTrackArbitrationShadowEvidence({
        prepared,
        context,
      }) as unknown as Record<string, unknown>;
    } catch (error) {
      arbitrationShadow = {
        policyVersion: "source-liked-gate3c-v1",
        mode: "SHADOW_ONLY",
        plannerInfluence: false,
        status: "ERROR",
        reason: "ARBITRATION_SHADOW_FAILED",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const currentPlanUnchanged = planFingerprint(context.plan) === currentFingerprint;
    runState.likedTrackSourceShadow = {
      ...(runState.likedTrackSourceShadow ?? summaryBase()),
      status: currentPlanUnchanged ? "READY" : "ERROR",
      attempted: true,
      reason: currentPlanUnchanged
        ? "SHADOW_COMPARISON_COMPLETE"
        : "AUTHORITATIVE_PLAN_MUTATED",
      shadowOnly: true,
      plannerInfluence: false,
      dbWrites: false,
      spotifyWrites: false,
      providerReads: false,
      currentPlanUnchanged,
      targetInputs,
      targets: comparisons,
      likedSourceCandidatesSelected: comparisons.reduce(
        (sum, item) =>
          sum +
          ("likedSourceCandidatesSelected" in item
            ? Number(item.likedSourceCandidatesSelected ?? 0)
            : 0),
        0,
      ),
      arbitrationShadow,
    };
  } catch (error) {
    runState.likedTrackSourceShadow = {
      ...(runState.likedTrackSourceShadow ?? summaryBase()),
      status: "ERROR",
      attempted: true,
      reason: "SHADOW_COMPARISON_FAILED",
      plannerInfluence: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyProductivePilot(
  prepared: PreparedLikedTrackSourceShadow,
  context: LikedTrackSourceShadowContext,
): void {
  const runState = currentMusicRepeatState();
  if (!runState) return;

  const targetIds = prepared.plannerPilotTargetIds ?? new Set<string>();
  const currentSummary = productivePilotSummary(runState.likedTrackSourceShadow);
  const allowedTargets = context.targets.filter((target) =>
    targetIds.has(target.targetPlaylistId),
  );
  if (allowedTargets.length === 0) {
    setProductivePilotSummary({
      ...currentSummary,
      status: "ABSTAINED",
      reason: "NO_ALLOWLISTED_TARGET_IN_RUN",
      attempted: false,
      plannerInfluence: false,
    });
    return;
  }

  try {
    // collectIncrementally has just run MUSIC-01 pre-write revalidation for real
    // runs. Re-filter against that exact refreshed context before any mutation,
    // so injected liked tracks cannot bypass the same cooldown snapshot.
    const refreshedRepeat = filterMusicCandidatesForRepeat(
      prepared.candidates,
      runState.context,
    );
    const proposal = buildLikedTrackProductivePilotPlan({
      candidates: refreshedRepeat.candidates,
      targetIds,
      context,
    });

    const changed = proposal.changed;
    const applied = proposal.safe && changed;
    if (applied) {
      context.plan.targets.splice(
        0,
        context.plan.targets.length,
        ...proposal.plan.targets,
      );
    }

    setProductivePilotSummary({
      ...currentSummary,
      status: proposal.safe ? (changed ? "APPLIED" : "NOOP") : "ABSTAINED",
      reason: proposal.safe
        ? changed
          ? "PRODUCTIVE_PILOT_APPLIED"
          : "PRODUCTIVE_PILOT_NO_CHANGE"
        : "PRODUCTIVE_PILOT_GUARD_REJECTED",
      attempted: true,
      plannerInfluence: applied,
      appliedToAuthoritativePlan: applied,
      exposurePercent: LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.exposurePercent,
      repeatEligibleCandidates: refreshedRepeat.candidates.length,
      repeatBlockedCandidates: refreshedRepeat.recentlyPlayedSkippedCount,
      missingTrackIdentityCandidates:
        refreshedRepeat.missingTrackIdentitySkippedCount,
      guardFailures: proposal.guardFailures,
      targetInputs: proposal.targetInputs,
      targets: proposal.targets,
      sourceProviderReads: 0,
      sourceDbWrites: false,
    });
  } catch (error) {
    setProductivePilotSummary({
      ...currentSummary,
      status: "ERROR",
      reason: "PRODUCTIVE_PILOT_FAILED",
      attempted: true,
      plannerInfluence: false,
      appliedToAuthoritativePlan: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Pure Gate 5A proposal builder used by runtime and tests. */
export function buildLikedTrackProductivePilotPlan(input: {
  candidates: readonly Candidate[];
  targetIds: ReadonlySet<string>;
  context: LikedTrackSourceShadowContext;
}): LikedTrackProductivePilotProposal {
  const { candidates, targetIds, context } = input;
  const likedUris = new Set(candidates.map((candidate) => candidate.uri));
  const variantMusicPoolByTargetId = new Map<string, Candidate[]>();
  const exclusiveLikedUrisByTargetId = new Map<string, Set<string>>();
  const targetInputs: Array<Record<string, unknown>> = [];

  for (const target of context.targets) {
    const currentPool =
      context.musicPoolByTargetId?.get(target.targetPlaylistId) ?? context.pools.music;
    const currentUris = new Set(currentPool.map((candidate) => candidate.uri));
    const allowlisted = targetIds.has(target.targetPlaylistId);
    const blocked = context.blockedMusicTrackIdsByTargetId?.get(
      target.targetPlaylistId,
    );
    const exclusiveBeforeNegative = allowlisted
      ? candidates.filter((candidate) => !currentUris.has(candidate.uri))
      : [];
    const exclusiveEligible = exclusiveBeforeNegative.filter(
      (candidate) =>
        !candidate.spotifyTrackId || !blocked?.has(candidate.spotifyTrackId),
    );
    const exclusiveUris = new Set(
      exclusiveEligible.map((candidate) => candidate.uri),
    );
    exclusiveLikedUrisByTargetId.set(target.targetPlaylistId, exclusiveUris);

    variantMusicPoolByTargetId.set(
      target.targetPlaylistId,
      allowlisted
        ? interleaveExclusiveLiked(
            currentPool,
            exclusiveEligible,
            LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.exposurePercent,
          )
        : [...currentPool],
    );

    targetInputs.push({
      targetPlaylistId: target.targetPlaylistId,
      targetName: target.name,
      allowlisted,
      exposurePercent: LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.exposurePercent,
      currentMusicPoolCount: currentPool.length,
      likedCandidateCount: allowlisted ? candidates.length : 0,
      overlapCurrentPool: allowlisted
        ? candidates.filter((candidate) => currentUris.has(candidate.uri)).length
        : 0,
      exclusiveLikedBeforeNegative: exclusiveBeforeNegative.length,
      exclusiveLikedEligible: exclusiveEligible.length,
      negativeSignalBlocked:
        exclusiveBeforeNegative.length - exclusiveEligible.length,
      variantMusicPoolCount:
        variantMusicPoolByTargetId.get(target.targetPlaylistId)?.length ?? 0,
    });
  }

  const variantPools: PlannerPools = {
    ...context.pools,
    music: dedupeByUri([...context.pools.music, ...candidates]),
  };
  const variantPlan = planRun({
    pools: variantPools,
    targets: context.targets,
    musicPoolByTargetId: variantMusicPoolByTargetId,
    preservedByTargetId: context.preservedByTargetId,
    blockedMusicTrackIdsByTargetId: context.blockedMusicTrackIdsByTargetId,
    initialReserved: context.initialReserved,
  });

  const guardFailures: Array<Record<string, unknown>> = [];
  const targets = context.plan.targets.map((currentTarget) => {
    const variantTarget = variantPlan.targets.find(
      (target) => target.targetPlaylistId === currentTarget.targetPlaylistId,
    );
    const allowlisted = targetIds.has(currentTarget.targetPlaylistId);
    if (!variantTarget) {
      guardFailures.push({
        targetPlaylistId: currentTarget.targetPlaylistId,
        targetName: currentTarget.name,
        reason: "VARIANT_TARGET_MISSING",
      });
      return {
        targetPlaylistId: currentTarget.targetPlaylistId,
        targetName: currentTarget.name,
        allowlisted,
        variantMissing: true,
      };
    }

    const currentFingerprint = targetFingerprint(currentTarget);
    const variantFingerprint = targetFingerprint(variantTarget);
    const currentUris = new Set(currentTarget.result.items.map((item) => item.uri));
    const variantUris = new Set(variantTarget.result.items.map((item) => item.uri));
    const exclusiveUris =
      exclusiveLikedUrisByTargetId.get(currentTarget.targetPlaylistId) ?? new Set();
    const selectedExclusive = variantTarget.result.items.filter((item) =>
      exclusiveUris.has(item.uri),
    );
    const currentLiked = currentTarget.result.items.filter(
      (item) => item.type === "MUSIC" && likedUris.has(item.uri),
    );
    const variantLiked = variantTarget.result.items.filter(
      (item) => item.type === "MUSIC" && likedUris.has(item.uri),
    );

    if (!allowlisted && currentFingerprint !== variantFingerprint) {
      guardFailures.push({
        targetPlaylistId: currentTarget.targetPlaylistId,
        targetName: currentTarget.name,
        reason: "NON_ALLOWLISTED_TARGET_CHANGED",
      });
    }
    if (allowlisted) {
      if (!variantTarget.result.stats.compositionQualityPassed) {
        guardFailures.push({
          targetPlaylistId: currentTarget.targetPlaylistId,
          targetName: currentTarget.name,
          reason: "COMPOSITION_QUALITY_REGRESSION",
        });
      }
      if (
        currentTarget.result.stats.sequenceQualityPassed &&
        !variantTarget.result.stats.sequenceQualityPassed
      ) {
        guardFailures.push({
          targetPlaylistId: currentTarget.targetPlaylistId,
          targetName: currentTarget.name,
          reason: "SEQUENCE_QUALITY_REGRESSION",
        });
      }
      if (
        variantTarget.result.stats.totalDurationMs <
        currentTarget.result.stats.totalDurationMs
      ) {
        guardFailures.push({
          targetPlaylistId: currentTarget.targetPlaylistId,
          targetName: currentTarget.name,
          reason: "DURATION_REGRESSION",
          currentDurationMs: currentTarget.result.stats.totalDurationMs,
          variantDurationMs: variantTarget.result.stats.totalDurationMs,
        });
      }
      if (
        variantTarget.result.stats.distinctArtistCount <
        currentTarget.result.stats.distinctArtistCount
      ) {
        guardFailures.push({
          targetPlaylistId: currentTarget.targetPlaylistId,
          targetName: currentTarget.name,
          reason: "ARTIST_DIVERSITY_REGRESSION",
        });
      }
      if (
        variantTarget.result.stats.distinctAlbumCount <
        currentTarget.result.stats.distinctAlbumCount
      ) {
        guardFailures.push({
          targetPlaylistId: currentTarget.targetPlaylistId,
          targetName: currentTarget.name,
          reason: "ALBUM_DIVERSITY_REGRESSION",
        });
      }
      if (
        variantTarget.result.stats.unfilledSlots >
        currentTarget.result.stats.unfilledSlots
      ) {
        guardFailures.push({
          targetPlaylistId: currentTarget.targetPlaylistId,
          targetName: currentTarget.name,
          reason: "UNFILLED_SLOTS_REGRESSION",
        });
      }
    }

    return {
      targetPlaylistId: currentTarget.targetPlaylistId,
      targetName: currentTarget.name,
      allowlisted,
      exposurePercent: LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.exposurePercent,
      current: compactStats(currentTarget.result),
      productive: compactStats(variantTarget.result),
      currentLikedSelectedCount: currentLiked.length,
      productiveLikedSelectedCount: variantLiked.length,
      deltaLikedSelected: variantLiked.length - currentLiked.length,
      exclusiveLikedSelectedCount: selectedExclusive.length,
      exclusiveLikedSelectedSample: selectedExclusive.slice(0, 10).map(sampleItem),
      selectedAddedVsCurrent: [...variantUris].filter(
        (uri) => !currentUris.has(uri),
      ).length,
      selectedRemovedVsCurrent: [...currentUris].filter(
        (uri) => !variantUris.has(uri),
      ).length,
      durationDeltaMs:
        variantTarget.result.stats.totalDurationMs -
        currentTarget.result.stats.totalDurationMs,
      distinctArtistDelta:
        variantTarget.result.stats.distinctArtistCount -
        currentTarget.result.stats.distinctArtistCount,
      distinctAlbumDelta:
        variantTarget.result.stats.distinctAlbumCount -
        currentTarget.result.stats.distinctAlbumCount,
    };
  });

  return {
    plan: variantPlan,
    safe: guardFailures.length === 0,
    changed: planFingerprint(variantPlan) !== planFingerprint(context.plan),
    guardFailures,
    targetInputs,
    targets,
  };
}

export function buildLikedTrackShadowCandidates(
  rows: ReadonlyArray<{
    spotifyTrackId: string;
    spotifyUri: string | null;
    trackName: string | null;
    primaryArtistId: string | null;
    primaryArtistName: string | null;
    albumId: string | null;
    albumName: string | null;
    durationMs: number | null;
    availability: LikedTrackAvailability;
  }>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const row of rows) {
    if (row.availability !== LikedTrackAvailability.AVAILABLE) continue;
    const uri = clean(row.spotifyUri);
    const title = clean(row.trackName);
    const spotifyTrackId = clean(row.spotifyTrackId);
    const durationMs = validDurationMs(row.durationMs);
    if (!uri || !title || !spotifyTrackId || durationMs === null) continue;
    candidates.push({
      uri,
      type: "MUSIC",
      title,
      subtitle: clean(row.primaryArtistName) ?? undefined,
      spotifyTrackId,
      primaryArtistId: clean(row.primaryArtistId) ?? undefined,
      primaryArtistName: clean(row.primaryArtistName) ?? undefined,
      albumId: clean(row.albumId) ?? undefined,
      albumName: clean(row.albumName) ?? undefined,
      durationMs,
    });
  }
  return dedupeByUri(candidates);
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

function sampleItem(
  item: PlanRunResult["targets"][number]["result"]["items"][number],
) {
  return {
    spotifyTrackId: item.spotifyTrackId ?? null,
    uri: item.uri,
    title: item.title,
    artist: item.primaryArtistName ?? null,
    durationMs: item.durationMs,
  };
}

function targetFingerprint(target: PlanRunResult["targets"][number]): string {
  return JSON.stringify({
    id: target.targetPlaylistId,
    uris: target.result.items.map((item) => item.uri),
    totalDurationMs: target.result.stats.totalDurationMs,
  });
}

function planFingerprint(plan: PlanRunResult): string {
  return JSON.stringify(plan.targets.map((target) => JSON.parse(targetFingerprint(target))));
}

function summaryBase(): Record<string, unknown> {
  return {
    policyVersion: LIKED_TRACK_SOURCE_SHADOW_POLICY.version,
    mode: LIKED_TRACK_SOURCE_SHADOW_POLICY.mode,
    arbitration: LIKED_TRACK_SOURCE_SHADOW_POLICY.arbitration,
    shadowOnly: true,
    plannerInfluence: false,
    providerReads: false,
    spotifyWrites: false,
    dbWrites: false,
    likedSourceProviderCalls: 0,
    status: "DISABLED",
    policyEnabled: false,
    attempted: false,
    reason: "MASTER_DISABLED",
    productivePilot: productivePilotSummaryBase({
      enabled: false,
      reason: "MASTER_DISABLED",
      targetIds: new Set(),
    }),
  };
}

function productivePilotSummaryBase(input: {
  enabled: boolean;
  reason: LikedTrackSourceShadowPolicyReason;
  targetIds: ReadonlySet<string>;
}): Record<string, unknown> {
  return {
    policyVersion: LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.version,
    mode: LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.mode,
    strategy: LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.strategy,
    exposurePercent: LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.exposurePercent,
    policyEnabled: input.enabled,
    policyReason: input.reason,
    targetAllowlist: [...input.targetIds],
    sourceProviderReads: 0,
    sourceDbWrites: false,
    plannerInfluence: false,
    appliedToAuthoritativePlan: false,
    attempted: false,
    status: input.enabled ? "PENDING_SOURCE" : "DISABLED",
    reason: input.reason,
  };
}

function productivePilotSummary(
  summary: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const value = summary?.productivePilot;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function setProductivePilotSummary(patch: Record<string, unknown>): void {
  const runState = currentMusicRepeatState();
  if (!runState) return;
  const base = runState.likedTrackSourceShadow ?? summaryBase();
  runState.likedTrackSourceShadow = {
    ...base,
    productivePilot: patch,
  };
}

function emptyPrepared(): PreparedLikedTrackSourceShadow {
  return {
    enabled: false,
    targetIds: new Set(),
    candidates: [],
    plannerPilotEnabled: false,
    plannerPilotTargetIds: new Set(),
  };
}

function resolveAllowlistedPolicy(input: {
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  allowlistedTargetIds?: string | null;
}): {
  enabled: boolean;
  reason: LikedTrackSourceShadowPolicyReason;
  targetIds: ReadonlySet<string>;
} {
  const targetIds = parseSet(input.allowlistedTargetIds);
  if (!parseBoolean(input.masterEnabled)) {
    return { enabled: false, reason: "MASTER_DISABLED", targetIds };
  }
  const email = normalizeEmail(input.userEmail);
  if (!email) {
    return { enabled: false, reason: "USER_EMAIL_MISSING", targetIds };
  }
  const users = new Set(
    String(input.allowlistedEmails ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value): value is string => Boolean(value)),
  );
  if (!users.has(email)) {
    return { enabled: false, reason: "USER_NOT_ALLOWLISTED", targetIds };
  }
  if (targetIds.size === 0) {
    return { enabled: false, reason: "TARGET_ALLOWLIST_EMPTY", targetIds };
  }
  return { enabled: true, reason: "ENABLED", targetIds };
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

function parseBoolean(value: string | null | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function parseSet(value: string | null | undefined): ReadonlySet<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function validDurationMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
