import { LikedTrackPreferenceProvenance } from "@prisma/client";

import {
  applyLikedTrackAffinityPlan,
  buildLikedTrackAffinityPlan,
  loadExistingLikedTrackAffinityState,
  type ExistingLikedTrack,
  type LikedTrackAffinityPlan,
} from "@/services/music-preference/liked-track-affinity";
import { readSpotifyLikedTrackInventory } from "@/services/music-preference/liked-track-inventory";
import { getSpotifyAccessToken } from "@/services/spotify/token";

export const DEFAULT_LIKED_TRACK_RECONCILIATION_LIMITS = {
  maxUnlikes: 25,
  maxUnlikePercent: 5,
} as const;

export type LikedTrackReconciliationMode = "PREVIEW" | "APPLY";
export type LikedTrackReconciliationSafetyStatus =
  | "READY"
  | "BASELINE_REQUIRED"
  | "REVIEW_REQUIRED"
  | "BLOCKED";

export type LikedTrackReconciliationSafetyReason =
  | "SAFE"
  | "BASELINE_REQUIRED"
  | "CANONICAL_ID_GAPS"
  | "UNLIKE_COUNT_LIMIT"
  | "UNLIKE_PERCENT_LIMIT";

export type LikedTrackReconciliationLimits = {
  maxUnlikes: number;
  maxUnlikePercent: number;
};

export type LikedTrackReconciliationSafety = {
  status: LikedTrackReconciliationSafetyStatus;
  reasons: LikedTrackReconciliationSafetyReason[];
  unlikeCount: number;
  unlikePercent: number;
  rowsWithoutCanonicalId: number;
  limits: LikedTrackReconciliationLimits;
  automaticApplyAllowed: boolean;
  manualForceAllowed: boolean;
};

export type LikedTrackReconciliationReport = {
  generatedAt: Date;
  mode: LikedTrackReconciliationMode;
  status: LikedTrackReconciliationSafetyStatus;
  safety: LikedTrackReconciliationSafety;
  applied: boolean;
  forced: boolean;
  provider: {
    rows: number;
    distinctCanonicalTracks: number;
    technicalDuplicateRows: number;
    rowsWithoutCanonicalId: number;
    pagesRead: number;
    providerCalls: number;
    retries: number;
    rateLimitedCount: number;
    retryWaitMs: number;
  };
  before: LikedTrackAffinityPlan["before"];
  planned: {
    tracksToCreate: number;
    tracksToReactivate: number;
    tracksToUnlike: number;
    trackMetadataUpdates: number;
    evidenceToCreate: number;
    evidenceToReactivate: number;
    evidenceToDeactivate: number;
    evidenceMetadataUpdates: number;
    affinityStatesToCreate: number;
    affinityStatesToUpdate: number;
  };
  after: LikedTrackAffinityPlan["after"];
  unlikeSample: Array<{
    spotifyTrackId: string;
    title: string | null;
    artist: string | null;
    addedAt: Date | null;
  }>;
  fullScan: true;
  plannerInfluence: false;
  spotifyWrites: false;
};

/**
 * SOURCE-LIKED-01 Gate 4C.
 *
 * Unlike detection cannot be incremental because Spotify Saved Tracks exposes
 * additions through added_at but not a removal event stream. This reconciler
 * therefore performs a complete read-only provider scan, compares it with the
 * canonical local liked-track state and reuses the LIKED-01 affinity plan.
 *
 * APPLY is guarded by a circuit breaker. Missing canonical IDs are a hard
 * blocker. Large removal sets require explicit manual review/force so a
 * truncated or otherwise suspicious provider response cannot mass-unlike the
 * local library automatically.
 */
export async function reconcileLikedTracks(
  userId: string,
  options: {
    mode?: LikedTrackReconciliationMode;
    force?: boolean;
    limits?: Partial<LikedTrackReconciliationLimits>;
  } = {},
): Promise<LikedTrackReconciliationReport> {
  const mode = options.mode ?? "PREVIEW";
  const force = options.force === true;
  const generatedAt = new Date();
  const limits = normalizeLimits(options.limits);
  const existing = await loadExistingLikedTrackAffinityState(userId);
  const activeLikedTracks = existing.tracks.filter((track) => track.isLiked).length;

  if (activeLikedTracks === 0) {
    const safety = evaluateLikedTrackReconciliationSafety({
      beforeLikedTracks: 0,
      tracksToUnlike: 0,
      rowsWithoutCanonicalId: 0,
      limits,
    });
    return baselineRequiredReport(generatedAt, mode, safety);
  }

  const accessToken = await getSpotifyAccessToken(userId);
  const provider = await readSpotifyLikedTrackInventory(accessToken);
  const plan = buildLikedTrackAffinityPlan(
    provider,
    existing,
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    generatedAt,
  );
  const safety = evaluateLikedTrackReconciliationSafety({
    beforeLikedTracks: plan.before.likedTracks,
    tracksToUnlike: plan.tracksToUnlike.length,
    rowsWithoutCanonicalId: plan.tracksWithoutCanonicalId,
    limits,
  });

  const forceCanBypass = safety.status === "REVIEW_REQUIRED" && safety.manualForceAllowed;
  const applyAllowed = safety.status === "READY" || (force && forceCanBypass);
  const applied = mode === "APPLY" && applyAllowed;

  if (applied) {
    await applyLikedTrackAffinityPlan(userId, plan);
  }

  return buildReport({
    generatedAt,
    mode,
    force,
    applied,
    provider,
    existingTracks: existing.tracks,
    plan,
    safety,
  });
}

export function evaluateLikedTrackReconciliationSafety(input: {
  beforeLikedTracks: number;
  tracksToUnlike: number;
  rowsWithoutCanonicalId: number;
  limits?: Partial<LikedTrackReconciliationLimits>;
}): LikedTrackReconciliationSafety {
  const limits = normalizeLimits(input.limits);
  const unlikePercent =
    input.beforeLikedTracks > 0
      ? (input.tracksToUnlike / input.beforeLikedTracks) * 100
      : 0;

  if (input.beforeLikedTracks <= 0) {
    return {
      status: "BASELINE_REQUIRED",
      reasons: ["BASELINE_REQUIRED"],
      unlikeCount: input.tracksToUnlike,
      unlikePercent,
      rowsWithoutCanonicalId: input.rowsWithoutCanonicalId,
      limits,
      automaticApplyAllowed: false,
      manualForceAllowed: false,
    };
  }

  if (input.rowsWithoutCanonicalId > 0) {
    return {
      status: "BLOCKED",
      reasons: ["CANONICAL_ID_GAPS"],
      unlikeCount: input.tracksToUnlike,
      unlikePercent,
      rowsWithoutCanonicalId: input.rowsWithoutCanonicalId,
      limits,
      automaticApplyAllowed: false,
      manualForceAllowed: false,
    };
  }

  const reasons: LikedTrackReconciliationSafetyReason[] = [];
  if (input.tracksToUnlike > limits.maxUnlikes) {
    reasons.push("UNLIKE_COUNT_LIMIT");
  }
  if (unlikePercent > limits.maxUnlikePercent) {
    reasons.push("UNLIKE_PERCENT_LIMIT");
  }

  if (reasons.length > 0) {
    return {
      status: "REVIEW_REQUIRED",
      reasons,
      unlikeCount: input.tracksToUnlike,
      unlikePercent,
      rowsWithoutCanonicalId: input.rowsWithoutCanonicalId,
      limits,
      automaticApplyAllowed: false,
      manualForceAllowed: true,
    };
  }

  return {
    status: "READY",
    reasons: ["SAFE"],
    unlikeCount: input.tracksToUnlike,
    unlikePercent,
    rowsWithoutCanonicalId: input.rowsWithoutCanonicalId,
    limits,
    automaticApplyAllowed: true,
    manualForceAllowed: false,
  };
}

function buildReport(input: {
  generatedAt: Date;
  mode: LikedTrackReconciliationMode;
  force: boolean;
  applied: boolean;
  provider: Awaited<ReturnType<typeof readSpotifyLikedTrackInventory>>;
  existingTracks: ExistingLikedTrack[];
  plan: LikedTrackAffinityPlan;
  safety: LikedTrackReconciliationSafety;
}): LikedTrackReconciliationReport {
  const existingByTrackId = new Map(
    input.existingTracks.map((track) => [track.spotifyTrackId, track]),
  );
  const unlikeSample = input.plan.tracksToUnlike.slice(0, 10).map((spotifyTrackId) => {
    const track = existingByTrackId.get(spotifyTrackId);
    return {
      spotifyTrackId,
      title: track?.trackName ?? null,
      artist: track?.primaryArtistName ?? null,
      addedAt: track?.addedAt ?? null,
    };
  });

  return {
    generatedAt: input.generatedAt,
    mode: input.mode,
    status: input.safety.status,
    safety: input.safety,
    applied: input.applied,
    forced: input.applied && input.force && input.safety.status === "REVIEW_REQUIRED",
    provider: {
      rows: input.provider.items.length,
      distinctCanonicalTracks: input.plan.currentTracks.length,
      technicalDuplicateRows: input.plan.technicalDuplicateRows,
      rowsWithoutCanonicalId: input.plan.tracksWithoutCanonicalId,
      pagesRead: input.provider.pagesRead,
      providerCalls: input.provider.providerCalls,
      retries: input.provider.retries,
      rateLimitedCount: input.provider.rateLimitedCount,
      retryWaitMs: input.provider.retryWaitMs,
    },
    before: input.plan.before,
    planned: plannedCounts(input.plan),
    after: input.plan.after,
    unlikeSample,
    fullScan: true,
    plannerInfluence: false,
    spotifyWrites: false,
  };
}

function baselineRequiredReport(
  generatedAt: Date,
  mode: LikedTrackReconciliationMode,
  safety: LikedTrackReconciliationSafety,
): LikedTrackReconciliationReport {
  const emptyState = { likedTracks: 0, activeEvidence: 0, activeArtists: 0 };
  return {
    generatedAt,
    mode,
    status: "BASELINE_REQUIRED",
    safety,
    applied: false,
    forced: false,
    provider: {
      rows: 0,
      distinctCanonicalTracks: 0,
      technicalDuplicateRows: 0,
      rowsWithoutCanonicalId: 0,
      pagesRead: 0,
      providerCalls: 0,
      retries: 0,
      rateLimitedCount: 0,
      retryWaitMs: 0,
    },
    before: emptyState,
    planned: {
      tracksToCreate: 0,
      tracksToReactivate: 0,
      tracksToUnlike: 0,
      trackMetadataUpdates: 0,
      evidenceToCreate: 0,
      evidenceToReactivate: 0,
      evidenceToDeactivate: 0,
      evidenceMetadataUpdates: 0,
      affinityStatesToCreate: 0,
      affinityStatesToUpdate: 0,
    },
    after: emptyState,
    unlikeSample: [],
    fullScan: true,
    plannerInfluence: false,
    spotifyWrites: false,
  };
}

function plannedCounts(plan: LikedTrackAffinityPlan) {
  return {
    tracksToCreate: plan.tracksToCreate.length,
    tracksToReactivate: plan.tracksToReactivate.length,
    tracksToUnlike: plan.tracksToUnlike.length,
    trackMetadataUpdates: plan.trackMetadataUpdates.length,
    evidenceToCreate: plan.evidenceToCreate.length,
    evidenceToReactivate: plan.evidenceToReactivate.length,
    evidenceToDeactivate: plan.evidenceToDeactivate.length,
    evidenceMetadataUpdates: plan.evidenceMetadataUpdates.length,
    affinityStatesToCreate: plan.affinityStatesToCreate.length,
    affinityStatesToUpdate: plan.affinityStatesToUpdate.length,
  };
}

function normalizeLimits(
  input: Partial<LikedTrackReconciliationLimits> | undefined,
): LikedTrackReconciliationLimits {
  return {
    maxUnlikes: positiveInteger(
      input?.maxUnlikes,
      DEFAULT_LIKED_TRACK_RECONCILIATION_LIMITS.maxUnlikes,
    ),
    maxUnlikePercent: positiveNumber(
      input?.maxUnlikePercent,
      DEFAULT_LIKED_TRACK_RECONCILIATION_LIMITS.maxUnlikePercent,
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
