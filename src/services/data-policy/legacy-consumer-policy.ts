import type { DataLineage, PolicyDecision, PolicyUse, RootDataSource } from "./provenance";
import {
  lineageFromRootSource,
  policyDecisionForLineage,
} from "./provenance";
import {
  lineageForDiscoveryListeningEvent,
  type DiscoveryListeningEventPolicyInput,
} from "./discovery-profile-policy";

export type RequiredPolicyUsesEvaluation = Readonly<{
  lineage: DataLineage;
  uses: readonly PolicyUse[];
  decisions: Readonly<Partial<Record<PolicyUse, PolicyDecision>>>;
  allowed: boolean;
}>;

export const MUSIC_REPEAT_PRODUCTIVE_USES = [
  "OPERATIONAL_PLANNING",
  "PLANNER_ELIGIBILITY",
] as const satisfies readonly PolicyUse[];

export const SAVED_TRACKS_SHADOW_USES = [
  "BEHAVIORAL_ANALYTICS",
] as const satisfies readonly PolicyUse[];

export const SAVED_TRACKS_PLANNER_USES = [
  "OPERATIONAL_PLANNING",
  "PLANNER_ELIGIBILITY",
] as const satisfies readonly PolicyUse[];

export const HISTORY_ANALYTICS_USES = [
  "BEHAVIORAL_ANALYTICS",
] as const satisfies readonly PolicyUse[];

export const HISTORY_RECOMMENDATION_USES = [
  "BEHAVIORAL_ANALYTICS",
  "USER_PROFILING",
  "RECOMMENDATION",
] as const satisfies readonly PolicyUse[];

export const ALBUM_RECOMMENDATION_USES = [
  "RECOMMENDATION",
] as const satisfies readonly PolicyUse[];

/**
 * Gate 5C central fail-closed evaluator for legacy consumers.
 * REVIEW_REQUIRED is not productive permission: every required use must be
 * explicitly ALLOW before the source/lineage can influence a consumer.
 */
export function evaluateRootSourceForUses(
  source: RootDataSource,
  uses: readonly PolicyUse[],
): RequiredPolicyUsesEvaluation {
  return evaluateLineageForUses(lineageFromRootSource(source), uses);
}

export function evaluateListeningEventForUses(
  input: DiscoveryListeningEventPolicyInput,
  uses: readonly PolicyUse[],
): RequiredPolicyUsesEvaluation {
  return evaluateLineageForUses(lineageForDiscoveryListeningEvent(input), uses);
}

export function evaluateLineageForUses(
  lineage: DataLineage,
  uses: readonly PolicyUse[],
): RequiredPolicyUsesEvaluation {
  const decisions: Partial<Record<PolicyUse, PolicyDecision>> = {};
  let allowed = uses.length > 0;

  for (const use of uses) {
    const decision = policyDecisionForLineage(lineage, use);
    decisions[use] = decision;
    if (decision !== "ALLOW") allowed = false;
  }

  return Object.freeze({
    lineage,
    uses: Object.freeze([...uses]),
    decisions: Object.freeze(decisions),
    allowed,
  });
}

export function spotifyRecentlyPlayedPlannerCapability(): RequiredPolicyUsesEvaluation {
  return evaluateRootSourceForUses(
    "SPOTIFY_RECENTLY_PLAYED",
    MUSIC_REPEAT_PRODUCTIVE_USES,
  );
}

export function spotifySavedTracksShadowCapability(): RequiredPolicyUsesEvaluation {
  return evaluateRootSourceForUses(
    "SPOTIFY_SAVED_TRACKS",
    SAVED_TRACKS_SHADOW_USES,
  );
}

export function spotifySavedTracksPlannerCapability(): RequiredPolicyUsesEvaluation {
  return evaluateRootSourceForUses(
    "SPOTIFY_SAVED_TRACKS",
    SAVED_TRACKS_PLANNER_USES,
  );
}

export function spotifyCatalogRecommendationCapability(): RequiredPolicyUsesEvaluation {
  return evaluateRootSourceForUses("SPOTIFY_CATALOG", ALBUM_RECOMMENDATION_USES);
}

/**
 * SQL aggregation cannot inspect/merge arbitrary JSON lineage safely before
 * grouping. Gate 5C therefore requires an explicit source-level allowlist in
 * addition to the capability matrix. There are currently no ListeningEventSource
 * variants whose rows are safe for behavioral/recommendation SQL aggregation.
 * A future first-party event source must be added here deliberately after its
 * metadata contract is proven not to carry provider enrichment.
 */
export const SQL_AGGREGATE_LINEAGE_SAFE_LISTENING_EVENT_SOURCES = [] as const;

export function sqlAggregateListeningEventSourcesForUses(
  uses: readonly PolicyUse[],
): readonly string[] {
  return SQL_AGGREGATE_LINEAGE_SAFE_LISTENING_EVENT_SOURCES.filter((source) =>
    evaluateListeningEventForUses({ source }, uses).allowed,
  );
}
