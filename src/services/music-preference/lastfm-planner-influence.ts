import {
  music06LastFmPlannerCapability,
  type Music06LastFmPlannerCapability,
} from "@/services/data-policy";

import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import {
  DEFAULT_MUSIC_06_PLANNER_INFLUENCE_SHADOW_CONFIG,
  previewMusic06PlannerInfluenceShadow,
  type Music06PlannerCandidateInfluence,
  type Music06PlannerInfluenceConfig,
  type Music06PlannerShadowCandidate,
} from "./lastfm-planner-influence-shadow";
import type { Music06NegativeProjectionShadow } from "./lastfm-negative-projection-shadow";

export const MUSIC_06_PLANNER_PRODUCTIVE_POLICY_VERSION =
  "music-06-gate5b-v1" as const;

/**
 * Gate 5A thresholds are promoted unchanged into the first productive cut.
 * They remain deliberately conservative:
 * - track: >=3 assessed, >=2 negative, >=2 distinct negative days, skipRate >=50%;
 * - artist: >=6 assessed, >=3 negative, >=2 negative tracks, >=2 days, >=50%;
 * - bounded shift only; never removal.
 */
export const DEFAULT_MUSIC_06_PLANNER_PRODUCTIVE_CONFIG =
  DEFAULT_MUSIC_06_PLANNER_INFLUENCE_SHADOW_CONFIG;

export type Music06PlannerProductiveResult = Readonly<{
  mode: "PRODUCTIVE_BOUNDED_RERANK";
  policyVersion: typeof MUSIC_06_PLANNER_PRODUCTIVE_POLICY_VERSION;
  capability: Music06LastFmPlannerCapability;
  config: Music06PlannerInfluenceConfig;
  authorized: boolean;
  applied: boolean;
  eligibilityChanged: false;
  inputCandidateCount: number;
  outputCandidateCount: number;
  musicCandidateCount: number;
  influencedCandidateCount: number;
  explicitPreferenceSuppressedCount: number;
  trackProjectionInfluenceCount: number;
  artistProjectionInfluenceCount: number;
  maxObservedMusicRankShift: number;
  candidates: readonly Music06PlannerShadowCandidate[];
  influences: readonly Music06PlannerCandidateInfluence[];
}>;

/**
 * Productive Gate 5B bridge.
 *
 * The ranking algorithm is exactly the Gate 5A shadow algorithm. The only new
 * decision is whether its hypothetical output is allowed to become the actual
 * bounded order. Capability resolution is explicit and narrow: REVIEW_REQUIRED
 * is approved only for this personal/non-commercial MUSIC-06 rerank. Candidate
 * eligibility is never changed.
 */
export function applyMusic06PlannerInfluence(input: {
  candidates: readonly Music06PlannerShadowCandidate[];
  projection: Music06NegativeProjectionShadow;
  firstPartyPreferences?: readonly FirstPartyPlaybackPreference[];
  config?: Music06PlannerInfluenceConfig;
  capability?: Music06LastFmPlannerCapability;
}): Music06PlannerProductiveResult {
  const capability = input.capability ?? music06LastFmPlannerCapability();
  const preview = previewMusic06PlannerInfluenceShadow({
    candidates: input.candidates,
    projection: input.projection,
    firstPartyPreferences: input.firstPartyPreferences,
    config: input.config ?? DEFAULT_MUSIC_06_PLANNER_PRODUCTIVE_CONFIG,
  });

  const authorized = capability.boundedRerankAllowed;
  const candidates = authorized
    ? preview.hypotheticalCandidates
    : input.candidates.map((candidate) => ({ ...candidate }));

  return {
    mode: "PRODUCTIVE_BOUNDED_RERANK",
    policyVersion: MUSIC_06_PLANNER_PRODUCTIVE_POLICY_VERSION,
    capability,
    config: preview.config,
    authorized,
    applied: authorized && preview.influencedCandidateCount > 0,
    eligibilityChanged: false,
    inputCandidateCount: preview.inputCandidateCount,
    outputCandidateCount: candidates.length,
    musicCandidateCount: preview.musicCandidateCount,
    influencedCandidateCount: authorized ? preview.influencedCandidateCount : 0,
    explicitPreferenceSuppressedCount: preview.explicitPreferenceSuppressedCount,
    trackProjectionInfluenceCount: authorized
      ? preview.trackProjectionInfluenceCount
      : 0,
    artistProjectionInfluenceCount: authorized
      ? preview.artistProjectionInfluenceCount
      : 0,
    maxObservedMusicRankShift: authorized
      ? preview.maxObservedMusicRankShift
      : 0,
    candidates,
    influences: preview.influences,
  };
}
