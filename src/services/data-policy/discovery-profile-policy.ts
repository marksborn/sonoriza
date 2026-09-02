import type { DataLineage, PolicyDecision } from "./provenance";
import {
  lineageFromOrigins,
  policyDecisionForLineage,
} from "./provenance";
import { LISTENING_EVENT_ORIGIN } from "./prisma-origin-mapping";

export const DISCOVERY_PROFILE_POLICY_USES = [
  "BEHAVIORAL_ANALYTICS",
  "USER_PROFILING",
  "RECOMMENDATION",
] as const;

export type DiscoveryProfilePolicyUse =
  (typeof DISCOVERY_PROFILE_POLICY_USES)[number];

export type DiscoveryProfilePolicyEvaluation = Readonly<{
  lineage: DataLineage;
  decisions: Readonly<Record<DiscoveryProfilePolicyUse, PolicyDecision>>;
  allowed: boolean;
}>;

export type DiscoveryListeningEventPolicyInput = Readonly<{
  source: string;
  metadata?: unknown;
  /**
   * PERF-01 projected history does not carry the original JSON object across
   * the SQL boundary. This flag preserves the fact that Spotify Extended
   * History contributed to the row so mixed lineage cannot be laundered.
   */
  spotifyExtendedHistoryPresent?: boolean;
}>;

/**
 * Gate 5 requires a discovery history input to be independently allowed for
 * behavioral analytics, user profiling and recommendation. REVIEW_REQUIRED is
 * intentionally not enough: productive discovery remains fail-closed until the
 * relevant capability is explicitly approved.
 */
export function evaluateDiscoveryProfileLineage(
  lineage: DataLineage,
): DiscoveryProfilePolicyEvaluation {
  const behavioralAnalytics = policyDecisionForLineage(
    lineage,
    "BEHAVIORAL_ANALYTICS",
  );
  const userProfiling = policyDecisionForLineage(lineage, "USER_PROFILING");
  const recommendation = policyDecisionForLineage(lineage, "RECOMMENDATION");

  const decisions = {
    BEHAVIORAL_ANALYTICS: behavioralAnalytics,
    USER_PROFILING: userProfiling,
    RECOMMENDATION: recommendation,
  } as const satisfies Readonly<
    Record<DiscoveryProfilePolicyUse, PolicyDecision>
  >;

  return {
    lineage,
    decisions,
    allowed: DISCOVERY_PROFILE_POLICY_USES.every(
      (use) => decisions[use] === "ALLOW",
    ),
  };
}

/**
 * Resolve all known contributors before evaluating the row. In particular, an
 * event whose canonical source is Last.fm can still carry Spotify lineage when
 * Extended Streaming History enriched the same canonical event.
 */
export function lineageForDiscoveryListeningEvent(
  input: DiscoveryListeningEventPolicyInput,
): DataLineage {
  const origin = originForListeningEventSourceValue(input.source);
  const spotifyExtendedHistoryPresent =
    input.spotifyExtendedHistoryPresent === true ||
    metadataHasSpotifyExtendedHistory(input.metadata);

  return lineageFromOrigins([
    origin,
    ...(spotifyExtendedHistoryPresent ? (["SPOTIFY"] as const) : []),
  ]);
}

export function evaluateDiscoveryListeningEvent(
  input: DiscoveryListeningEventPolicyInput,
): DiscoveryProfilePolicyEvaluation {
  return evaluateDiscoveryProfileLineage(
    lineageForDiscoveryListeningEvent(input),
  );
}

export function isDiscoveryListeningEventAllowed(
  input: DiscoveryListeningEventPolicyInput,
): boolean {
  return evaluateDiscoveryListeningEvent(input).allowed;
}

function originForListeningEventSourceValue(source: string) {
  if (Object.hasOwn(LISTENING_EVENT_ORIGIN, source)) {
    return LISTENING_EVENT_ORIGIN[
      source as keyof typeof LISTENING_EVENT_ORIGIN
    ];
  }
  return "UNKNOWN" as const;
}

function metadataHasSpotifyExtendedHistory(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;

  // Presence itself is provenance. A malformed or partial payload must not
  // become a way to hide Spotify lineage by failing a shape parser.
  return Object.hasOwn(metadata, "spotifyExtendedHistory");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
