import {
  lineageFromRootSource,
  policyDecisionForLineage,
  type DataLineage,
  type PolicyDecision,
} from "./provenance";

export const MUSIC_06_LASTFM_PLANNER_CAPABILITY_VERSION =
  "music-06-gate5b-personal-v1" as const;

/**
 * Explicit resolution of the REVIEW_REQUIRED baseline for one narrow use.
 *
 * Scope:
 * - personal/non-commercial Sonoriza;
 * - MUSIC-06 Last.fm + first-party published-order evidence only;
 * - bounded negative rerank (RECOMMENDATION) only;
 * - no candidate removal / PLANNER_ELIGIBILITY override;
 * - no AI/export permission.
 *
 * The baseline matrix remains unchanged. A DENY can never be upgraded here.
 */
export const MUSIC_06_LASTFM_PERSONAL_RERANK_APPROVAL = Object.freeze({
  issue: 277,
  scope: "PERSONAL_NON_COMMERCIAL" as const,
  capability: "MUSIC_06_LASTFM_BOUNDED_RERANK" as const,
  approved: true,
});

export type Music06LastFmPlannerCapability = Readonly<{
  policyVersion: typeof MUSIC_06_LASTFM_PLANNER_CAPABILITY_VERSION;
  lineage: DataLineage;
  baselineRecommendationDecision: PolicyDecision;
  baselinePlannerEligibilityDecision: PolicyDecision;
  boundedRerankDecision: PolicyDecision;
  plannerEligibilityDecision: PolicyDecision;
  approval: typeof MUSIC_06_LASTFM_PERSONAL_RERANK_APPROVAL;
  boundedRerankAllowed: boolean;
  eligibilityChangeAllowed: false;
}>;

export function music06LastFmPlannerCapability(): Music06LastFmPlannerCapability {
  const lineage = lineageFromRootSource("LASTFM_SCROBBLE");
  const baselineRecommendationDecision = policyDecisionForLineage(
    lineage,
    "RECOMMENDATION",
  );
  const baselinePlannerEligibilityDecision = policyDecisionForLineage(
    lineage,
    "PLANNER_ELIGIBILITY",
  );

  const boundedRerankDecision = resolveReviewedCapability(
    baselineRecommendationDecision,
    MUSIC_06_LASTFM_PERSONAL_RERANK_APPROVAL.approved,
  );

  // Deliberately unresolved: MUSIC-06 Gate 5B never removes/hard-excludes a
  // candidate based on inferred Last.fm behavior.
  const plannerEligibilityDecision = baselinePlannerEligibilityDecision;

  return {
    policyVersion: MUSIC_06_LASTFM_PLANNER_CAPABILITY_VERSION,
    lineage,
    baselineRecommendationDecision,
    baselinePlannerEligibilityDecision,
    boundedRerankDecision,
    plannerEligibilityDecision,
    approval: MUSIC_06_LASTFM_PERSONAL_RERANK_APPROVAL,
    boundedRerankAllowed: boundedRerankDecision === "ALLOW",
    eligibilityChangeAllowed: false,
  };
}

function resolveReviewedCapability(
  baseline: PolicyDecision,
  approved: boolean,
): PolicyDecision {
  if (baseline === "DENY") return "DENY";
  if (baseline === "ALLOW") return "ALLOW";
  return approved ? "ALLOW" : "REVIEW_REQUIRED";
}
