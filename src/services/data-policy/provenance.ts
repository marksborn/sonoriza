/**
 * SPOTIFY-COMPLIANCE-01 / Gate 2
 *
 * Provider-neutral data lineage and allowed-use contract.
 *
 * This module is intentionally pure. It does not read the database, call a
 * provider, or change planner behavior. Consumers opt in explicitly in later
 * gates. A derived value must carry the union of every contributing origin;
 * the most restrictive policy decision always wins.
 */

export const DATA_ORIGINS = [
  "FIRST_PARTY",
  "SPOTIFY",
  "LASTFM",
  "OTHER_PROVIDER",
  "USER_IMPORT",
  "UNKNOWN",
] as const;

export type DataOrigin = (typeof DATA_ORIGINS)[number];

export const POLICY_USES = [
  "DISPLAY",
  "OPERATIONAL_PLANNING",
  "BEHAVIORAL_ANALYTICS",
  "USER_PROFILING",
  "RECOMMENDATION",
  "PLANNER_ELIGIBILITY",
  "AI",
  "EXTERNAL_EXPORT",
] as const;

export type PolicyUse = (typeof POLICY_USES)[number];

export const POLICY_DECISIONS = ["ALLOW", "REVIEW_REQUIRED", "DENY"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export type DataLineage = Readonly<{
  origins: readonly DataOrigin[];
}>;

export const ROOT_DATA_SOURCES = [
  "USER_EXPLICIT",
  "SONORIZA_INTERACTION",
  "SPOTIFY_RECENTLY_PLAYED",
  "SPOTIFY_EXTENDED_HISTORY",
  "SPOTIFY_SAVED_TRACKS",
  "SPOTIFY_PODCAST_PLAYBACK_STATE",
  "SPOTIFY_CATALOG",
  "LASTFM_SCROBBLE",
  "LASTFM_CATALOG",
  "USER_IMPORT",
  "OTHER_PROVIDER",
  "UNKNOWN",
] as const;

export type RootDataSource = (typeof ROOT_DATA_SOURCES)[number];

type OriginPolicy = Readonly<Record<PolicyUse, PolicyDecision>>;

const ORIGIN_ORDER = new Map<DataOrigin, number>(
  DATA_ORIGINS.map((origin, index) => [origin, index]),
);

const DECISION_WEIGHT: Readonly<Record<PolicyDecision, number>> = {
  ALLOW: 0,
  REVIEW_REQUIRED: 1,
  DENY: 2,
};

/**
 * Conservative baseline only. This is not a legal conclusion and it is not a
 * substitute for consent, contractual or provider-specific checks.
 *
 * Gate 2 deliberately marks provider-dependent commercial uses as
 * REVIEW_REQUIRED until a later gate has an explicit approved capability.
 */
export const DEFAULT_ORIGIN_POLICY = {
  FIRST_PARTY: {
    DISPLAY: "ALLOW",
    OPERATIONAL_PLANNING: "ALLOW",
    BEHAVIORAL_ANALYTICS: "ALLOW",
    USER_PROFILING: "ALLOW",
    RECOMMENDATION: "ALLOW",
    PLANNER_ELIGIBILITY: "ALLOW",
    AI: "REVIEW_REQUIRED",
    EXTERNAL_EXPORT: "REVIEW_REQUIRED",
  },
  SPOTIFY: {
    DISPLAY: "ALLOW",
    OPERATIONAL_PLANNING: "REVIEW_REQUIRED",
    BEHAVIORAL_ANALYTICS: "DENY",
    USER_PROFILING: "DENY",
    RECOMMENDATION: "DENY",
    PLANNER_ELIGIBILITY: "REVIEW_REQUIRED",
    AI: "DENY",
    EXTERNAL_EXPORT: "REVIEW_REQUIRED",
  },
  LASTFM: {
    DISPLAY: "REVIEW_REQUIRED",
    OPERATIONAL_PLANNING: "REVIEW_REQUIRED",
    BEHAVIORAL_ANALYTICS: "REVIEW_REQUIRED",
    USER_PROFILING: "REVIEW_REQUIRED",
    RECOMMENDATION: "REVIEW_REQUIRED",
    PLANNER_ELIGIBILITY: "REVIEW_REQUIRED",
    AI: "REVIEW_REQUIRED",
    EXTERNAL_EXPORT: "REVIEW_REQUIRED",
  },
  OTHER_PROVIDER: {
    DISPLAY: "REVIEW_REQUIRED",
    OPERATIONAL_PLANNING: "REVIEW_REQUIRED",
    BEHAVIORAL_ANALYTICS: "REVIEW_REQUIRED",
    USER_PROFILING: "REVIEW_REQUIRED",
    RECOMMENDATION: "REVIEW_REQUIRED",
    PLANNER_ELIGIBILITY: "REVIEW_REQUIRED",
    AI: "REVIEW_REQUIRED",
    EXTERNAL_EXPORT: "REVIEW_REQUIRED",
  },
  USER_IMPORT: {
    DISPLAY: "ALLOW",
    OPERATIONAL_PLANNING: "REVIEW_REQUIRED",
    BEHAVIORAL_ANALYTICS: "REVIEW_REQUIRED",
    USER_PROFILING: "REVIEW_REQUIRED",
    RECOMMENDATION: "REVIEW_REQUIRED",
    PLANNER_ELIGIBILITY: "REVIEW_REQUIRED",
    AI: "REVIEW_REQUIRED",
    EXTERNAL_EXPORT: "REVIEW_REQUIRED",
  },
  UNKNOWN: {
    DISPLAY: "REVIEW_REQUIRED",
    OPERATIONAL_PLANNING: "DENY",
    BEHAVIORAL_ANALYTICS: "DENY",
    USER_PROFILING: "DENY",
    RECOMMENDATION: "DENY",
    PLANNER_ELIGIBILITY: "DENY",
    AI: "DENY",
    EXTERNAL_EXPORT: "DENY",
  },
} as const satisfies Readonly<Record<DataOrigin, OriginPolicy>>;

export const ROOT_SOURCE_ORIGIN = {
  USER_EXPLICIT: "FIRST_PARTY",
  SONORIZA_INTERACTION: "FIRST_PARTY",
  SPOTIFY_RECENTLY_PLAYED: "SPOTIFY",
  SPOTIFY_EXTENDED_HISTORY: "SPOTIFY",
  SPOTIFY_SAVED_TRACKS: "SPOTIFY",
  SPOTIFY_PODCAST_PLAYBACK_STATE: "SPOTIFY",
  SPOTIFY_CATALOG: "SPOTIFY",
  LASTFM_SCROBBLE: "LASTFM",
  LASTFM_CATALOG: "LASTFM",
  USER_IMPORT: "USER_IMPORT",
  OTHER_PROVIDER: "OTHER_PROVIDER",
  UNKNOWN: "UNKNOWN",
} as const satisfies Readonly<Record<RootDataSource, DataOrigin>>;

export function lineageFromOrigins(origins: Iterable<DataOrigin>): DataLineage {
  const unique = new Set(origins);
  if (unique.size === 0) unique.add("UNKNOWN");

  return {
    origins: [...unique].sort(
      (left, right) =>
        (ORIGIN_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (ORIGIN_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  };
}

export function lineageFromRootSource(source: RootDataSource): DataLineage {
  return lineageFromOrigins([ROOT_SOURCE_ORIGIN[source]]);
}

export function mergeLineages(...lineages: readonly DataLineage[]): DataLineage {
  return lineageFromOrigins(lineages.flatMap((lineage) => lineage.origins));
}

export function policyDecisionForOrigin(
  origin: DataOrigin,
  use: PolicyUse,
): PolicyDecision {
  return DEFAULT_ORIGIN_POLICY[origin][use];
}

/**
 * No laundering: a derived value is only as permissive as its most restrictive
 * contributing origin for the requested use.
 */
export function policyDecisionForLineage(
  lineage: DataLineage,
  use: PolicyUse,
): PolicyDecision {
  const normalized = lineageFromOrigins(lineage.origins);
  let decision: PolicyDecision = "ALLOW";

  for (const origin of normalized.origins) {
    const candidate = policyDecisionForOrigin(origin, use);
    if (DECISION_WEIGHT[candidate] > DECISION_WEIGHT[decision]) {
      decision = candidate;
    }
    if (decision === "DENY") return decision;
  }

  return decision;
}

export function isUseAllowed(lineage: DataLineage, use: PolicyUse): boolean {
  return policyDecisionForLineage(lineage, use) === "ALLOW";
}
