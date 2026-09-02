import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";

export const DISCOVERY_GATE5H_ACQUISITION_POLICY = {
  artistSeeds: 8,
  trackSeeds: 8,
  perSeed: 15,
  bridgeSeeds: 5,
  bridgePerSeed: 15,
  topN: 30,
  maxPerPath: 2,
  maxPerRoot: 3,
  maxPerBridge: 2,
  repeatPenaltyPerSelection: 0.07,
  minimumAdjustedScore: 55,
} as const;

export const DISCOVERY_EXTERNAL_DATA_POLICY_ERROR_CODE =
  "DATA_POLICY_DISCOVERY_EXTERNAL_BLOCKED" as const;

export type RuntimeExternalDiscoveryEvidence = {
  lastFmCalls: number;
  lastFmFailures: number;
  combinedCandidateCount: number;
  eligibleBeforeArbitration: number;
  selectedAfterArbitration: number;
  spotifyCatalogCalls: number;
  spotifyFailures: number;
  spotifyRateLimits: number;
  spotifyRetries: number;
  resolvedCount: number;
  ambiguousCount: number;
  notFoundCount: number;
  providerFailureCount: number;
};

export type RuntimeExternalDiscoveryResult = {
  discoveries: Gate5FResolvedDiscoveryCandidate[];
  evidence: RuntimeExternalDiscoveryEvidence;
};

export class DiscoveryExternalDataPolicyError extends Error {
  readonly code = DISCOVERY_EXTERNAL_DATA_POLICY_ERROR_CODE;

  constructor() {
    super(
      "External discovery is blocked by data policy: Last.fm remains REVIEW_REQUIRED and Spotify-derived recommendation is DENY",
    );
    this.name = "DiscoveryExternalDataPolicyError";
  }
}

/**
 * Gate 5A productive external-discovery boundary.
 *
 * The previous runtime path built seeds from listening-history analytics, called
 * Last.fm similarity, resolved candidates through Spotify and then optionally
 * merged the Saved-Tracks/ArtistAffinity pilot. Those inputs are not currently
 * ALLOW for recommendation under the Gate 2 capability matrix:
 *
 * - Spotify-derived recommendation: DENY.
 * - Last.fm recommendation: REVIEW_REQUIRED.
 * - legacy Saved Tracks / ArtistAffinity provenance: Spotify-derived.
 *
 * Fail before reading a behavioral profile, TrackListeningEvent history,
 * Saved-Tracks affinity or invoking either provider. The caller already treats
 * acquisition failure as an abstention and keeps the existing plan, so the
 * compliance barrier cannot accidentally manufacture a replacement candidate.
 *
 * The pure external-discovery/scoring modules remain available for tests and a
 * future reviewed capability; this runtime entry point is the hard boundary.
 */
export async function resolveRuntimeExternalDiscovery(input: {
  userId: string;
  asOf: Date;
}): Promise<RuntimeExternalDiscoveryResult> {
  void input;
  throw new DiscoveryExternalDataPolicyError();
}
