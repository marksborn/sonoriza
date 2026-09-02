import {
  lineageFromRootSource,
  policyDecisionForLineage,
  type DataLineage,
  type PolicyDecision,
} from "@/services/data-policy";

import {
  analyzeAndRecordInferredSkips as analyzeAndRecordInferredSkipsLegacy,
  loadPendingInferredSkips as loadPendingInferredSkipsLegacy,
  type InferredSkipAnalysisResult,
  type InferredSkipAnalysisTargetResult,
} from "./analyze";
import type {
  MusicPreferenceSignalStore,
  PendingSkipSignal,
} from "./signal-store";

export const MUSIC_05_COMPLIANCE_QUARANTINE_REASON =
  "COMPLIANCE_QUARANTINED_SPOTIFY_INFERRED_SKIP" as const;

export type Music05CompliancePolicy = Readonly<{
  lineage: DataLineage;
  behavioralAnalytics: PolicyDecision;
  userProfiling: PolicyDecision;
  recommendation: PolicyDecision;
  plannerEligibility: PolicyDecision;
  productiveUseAllowed: boolean;
}>;

/**
 * MUSIC-05 derives behavioral inference from Spotify Recently Played history.
 * Gate 5 requires every productive use to be explicitly allowed by the central
 * provenance matrix. REVIEW_REQUIRED is not productive authorization.
 */
export function evaluateMusic05CompliancePolicy(): Music05CompliancePolicy {
  const lineage = lineageFromRootSource("SPOTIFY_RECENTLY_PLAYED");
  const behavioralAnalytics = policyDecisionForLineage(
    lineage,
    "BEHAVIORAL_ANALYTICS",
  );
  const userProfiling = policyDecisionForLineage(lineage, "USER_PROFILING");
  const recommendation = policyDecisionForLineage(lineage, "RECOMMENDATION");
  const plannerEligibility = policyDecisionForLineage(
    lineage,
    "PLANNER_ELIGIBILITY",
  );

  return {
    lineage,
    behavioralAnalytics,
    userProfiling,
    recommendation,
    plannerEligibility,
    productiveUseAllowed: [
      behavioralAnalytics,
      userProfiling,
      recommendation,
      plannerEligibility,
    ].every((decision) => decision === "ALLOW"),
  };
}

/**
 * Productive export used by generation jobs. The legacy implementation remains
 * available from ./analyze for diagnostic/integration coverage, but this public
 * service boundary refuses to create new provider-derived preference signals
 * while Spotify lineage is not authorized for these uses.
 */
export async function analyzeAndRecordInferredSkips(
  userId: string,
  targetPlaylistIds: readonly string[],
  options: {
    now?: Date;
    store?: MusicPreferenceSignalStore;
  } = {},
): Promise<InferredSkipAnalysisResult> {
  const policy = evaluateMusic05CompliancePolicy();
  if (!policy.productiveUseAllowed) {
    return {
      targets: targetPlaylistIds.map(quarantinedTargetResult),
    };
  }

  return analyzeAndRecordInferredSkipsLegacy(userId, targetPlaylistIds, options);
}

/**
 * Existing provider-derived pending rows remain persisted for audit/retention
 * work, but they no longer suppress tracks in productive planning. No deletion
 * happens in Gate 5.
 */
export async function loadPendingInferredSkips(
  userId: string,
  targetPlaylistIds: readonly string[],
  options: {
    store?: MusicPreferenceSignalStore;
    includeCurrentInference?: boolean;
  } = {},
): Promise<Map<string, PendingSkipSignal[]>> {
  const policy = evaluateMusic05CompliancePolicy();
  if (!policy.productiveUseAllowed) {
    return new Map(
      targetPlaylistIds.map((targetPlaylistId) => [targetPlaylistId, []]),
    );
  }

  return loadPendingInferredSkipsLegacy(userId, targetPlaylistIds, options);
}

function quarantinedTargetResult(
  targetPlaylistId: string,
): InferredSkipAnalysisTargetResult {
  return {
    targetPlaylistId,
    analyzedGenerationRunId: null,
    inferredSkipCount: 0,
    createdSignalCount: 0,
    duplicateSignalCount: 0,
    deferredEdgeTrackId: null,
    musicSubsequenceLength: 0,
    reason: MUSIC_05_COMPLIANCE_QUARANTINE_REASON,
  };
}
