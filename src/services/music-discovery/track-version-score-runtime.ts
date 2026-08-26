import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";
import {
  adjustTrackVersionScore,
  type TrackVersionScoreAdjustment,
} from "./track-version-score-policy";

export type VersionAdjustedDiscovery = Gate5FResolvedDiscoveryCandidate & {
  trackVersionAdjustment?: TrackVersionScoreAdjustment;
};

export function applyTrackVersionScoreToResolvedDiscovery(
  discovery: VersionAdjustedDiscovery,
): VersionAdjustedDiscovery {
  if (discovery.trackVersionAdjustment) return discovery;

  const adjustment = adjustTrackVersionScore({
    score: discovery.adjustedScore,
    trackName: discovery.candidate.title,
    albumName: discovery.candidate.albumName ?? null,
  });

  return {
    ...discovery,
    adjustedScore: adjustment.scoreAfter,
    resolutionReason:
      adjustment.multiplier < 1
        ? `${discovery.resolutionReason}|VERSION_${adjustment.classification}_X${adjustment.multiplier.toFixed(2)}_${adjustment.reason}`
        : discovery.resolutionReason,
    trackVersionAdjustment: adjustment,
  };
}

export function applyTrackVersionScoresToResolvedDiscoveries(
  discoveries: VersionAdjustedDiscovery[],
): VersionAdjustedDiscovery[] {
  return discoveries.map(applyTrackVersionScoreToResolvedDiscovery);
}
