import type { DiscoveryTrackProfile } from "./profile";
import {
  buildDiscoveryScoringReport,
  DISCOVERY_SCORE_CALIBRATION,
  type BuildDiscoveryScoringInput,
  type DiscoveryArtistScoreCard,
  type DiscoveryScoredTrackCandidate,
  type DiscoveryScoreReason,
  type DiscoveryScoringReport,
} from "./scoring";

type NegativeSignals = {
  adjustedExplicitSkipRate: number;
  penalty: number;
};

const SKIP_PRIOR_MEAN = DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.mean;
const SKIP_PRIOR_WEIGHT = DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.weight;

/**
 * PERF-01 COMPLETE scoring path.
 *
 * Gate 2.2 expands topN to cover the whole COMPLETE universe before calling
 * Gate 2.1. The legacy implementation materializes two full arrays of scored
 * track objects and only then filters ineligible rows. With tens of thousands
 * of historical tracks, most of those objects are short-lived allocation cost.
 *
 * This path keeps the exact public report contract while retaining only track
 * candidates that can actually appear in the report. Artist scoring remains on
 * the canonical implementation so weights/reasons stay single-sourced.
 */
export function buildDiscoveryScoringReportEligibleOnly(
  input: BuildDiscoveryScoringInput,
): DiscoveryScoringReport {
  // The optimized path relies on topArtistAffinity containing every artist.
  // Gate 2.2 guarantees this with expandedTopN. Fall back conservatively for
  // direct/diagnostic callers that request a partial topN.
  if (input.topN < input.artists.length || input.topN < input.tracks.length) {
    return buildDiscoveryScoringReport(input);
  }

  const base = buildDiscoveryScoringReport({
    ...input,
    tracks: [],
  });

  const artistByKey = new Map<string, DiscoveryArtistScoreCard>();
  for (const artist of base.topArtistAffinity) {
    artistByKey.set(normalized(artist.artistName), artist);
  }

  const rediscoveryEligibleIds = new Set<string>();
  const rediscoveryCandidates: DiscoveryScoredTrackCandidate[] = [];
  for (const track of input.tracks) {
    const candidate = scoreRediscoveryEligibleTrack(
      track,
      artistByKey,
      input.generatedAt,
      input.dormantDays,
    );
    if (!candidate) continue;
    rediscoveryEligibleIds.add(candidate.spotifyTrackId);
    rediscoveryCandidates.push(candidate);
  }
  rankEligibleInPlace(rediscoveryCandidates, input.topN);

  let preemptedFamiliarCount = 0;
  const familiarCandidates: DiscoveryScoredTrackCandidate[] = [];
  for (const track of input.tracks) {
    const candidate = scoreFamiliarEligibleTrack(track, artistByKey);
    if (!candidate) continue;
    if (rediscoveryEligibleIds.has(candidate.spotifyTrackId)) {
      preemptedFamiliarCount += 1;
      continue;
    }
    familiarCandidates.push(candidate);
  }
  rankEligibleInPlace(familiarCandidates, input.topN);

  return {
    ...base,
    selectionPolicy: {
      ...base.selectionPolicy,
      rediscoveryPreemptedFamiliarCount: preemptedFamiliarCount,
    },
    familiarCandidates,
    rediscoveryCandidates,
  };
}

function scoreFamiliarEligibleTrack(
  track: DiscoveryTrackProfile,
  artistByKey: Map<string, DiscoveryArtistScoreCard>,
): DiscoveryScoredTrackCandidate | null {
  const artist = artistByKey.get(normalized(track.artistName));
  const trackHistory = trackHistoricalStrength(track);
  const negative = scoreNegativeSignals(
    track.explicitSkipCount,
    track.extendedEvidenceCount,
    track.inferredSkipCount,
    track.pendingInferredSkipCount,
  );
  const weights = DISCOVERY_SCORE_CALIBRATION.weights.familiarTrack;
  const score = score100(
    clamp01(
      weights.trackHistory * trackHistory +
        weights.artistHistory * (artist?.components.historicalAffinity ?? 0) +
        weights.artistRecent * (artist?.components.recentAffinity ?? 0) +
        weights.negativePenalty * negative.penalty,
    ),
  );
  const eligible =
    track.cooldownEligible === true &&
    score >= DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.familiar;
  if (!eligible) return null;

  const reasons: DiscoveryScoreReason[] = [];
  addTrackQualityReasons(track, negative, reasons);
  addTrackHistoryReason(track, trackHistory, reasons);

  return {
    category: "FAMILIAR",
    spotifyTrackId: track.spotifyTrackId,
    trackName: track.trackName,
    artistName: track.artistName,
    score,
    eligible: true,
    components: {
      trackHistoricalStrength: rounded(trackHistory),
      artistHistoricalAffinity: artist?.components.historicalAffinity ?? 0,
      artistRecentAffinity: artist?.components.recentAffinity ?? 0,
      dormancy: 0,
      adjustedExplicitSkipRate: rounded(negative.adjustedExplicitSkipRate),
      negativePenalty: rounded(negative.penalty),
    },
    reasons,
  };
}

function scoreRediscoveryEligibleTrack(
  track: DiscoveryTrackProfile,
  artistByKey: Map<string, DiscoveryArtistScoreCard>,
  generatedAt: Date,
  dormantDays: number,
): DiscoveryScoredTrackCandidate | null {
  const artist = artistByKey.get(normalized(track.artistName));
  const trackHistory = trackHistoricalStrength(track);
  const negative = scoreNegativeSignals(
    track.explicitSkipCount,
    track.extendedEvidenceCount,
    track.inferredSkipCount,
    track.pendingInferredSkipCount,
  );
  const daysSinceLastPlay = wholeDaysBetween(track.lastPlayedAt, generatedAt);
  const dormancy =
    daysSinceLastPlay >= dormantDays
      ? clamp01(
          0.25 +
            0.75 *
              saturating(
                daysSinceLastPlay - dormantDays,
                DISCOVERY_SCORE_CALIBRATION.scales.rediscoveryExtraDays,
              ),
        )
      : 0;
  const baseEligible =
    track.cooldownEligible === true &&
    daysSinceLastPlay >= dormantDays &&
    track.playCount >= DISCOVERY_SCORE_CALIBRATION.thresholds.rediscoveryMinTrackPlays;

  const weights = DISCOVERY_SCORE_CALIBRATION.weights.rediscoveryTrack;
  const score = score100(
    clamp01(
      weights.trackHistory * trackHistory +
        weights.artistHistory * (artist?.components.historicalAffinity ?? 0) +
        weights.dormancy * dormancy +
        weights.artistRecent * (artist?.components.recentAffinity ?? 0) +
        weights.negativePenalty * negative.penalty,
    ),
  );
  const eligible =
    baseEligible &&
    score >= DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.rediscovery;
  if (!eligible) return null;

  const reasons: DiscoveryScoreReason[] = [
    {
      code: "LONG_DORMANCY",
      detail: `${daysSinceLastPlay} days since the last observed play.`,
    },
  ];
  addTrackQualityReasons(track, negative, reasons);
  addTrackHistoryReason(track, trackHistory, reasons);

  return {
    category: "REDESCOBERTA",
    spotifyTrackId: track.spotifyTrackId,
    trackName: track.trackName,
    artistName: track.artistName,
    score,
    eligible: true,
    components: {
      trackHistoricalStrength: rounded(trackHistory),
      artistHistoricalAffinity: artist?.components.historicalAffinity ?? 0,
      artistRecentAffinity: artist?.components.recentAffinity ?? 0,
      dormancy: rounded(dormancy),
      adjustedExplicitSkipRate: rounded(negative.adjustedExplicitSkipRate),
      negativePenalty: rounded(negative.penalty),
    },
    reasons,
  };
}

function addTrackQualityReasons(
  track: DiscoveryTrackProfile,
  negative: NegativeSignals,
  reasons: DiscoveryScoreReason[],
): void {
  addNegativeReason(
    track.explicitSkipCount,
    track.extendedEvidenceCount,
    track.explicitSkipRate,
    negative,
    reasons,
  );
  if (track.inferredSkipCount > 0) {
    reasons.push({
      code: "INFERRED_SKIP_SIGNAL",
      detail: `${track.inferredSkipCount} inferred skips (${track.pendingInferredSkipCount} pending).`,
    });
  }
}

function addNegativeReason(
  explicitSkipCount: number,
  extendedEvidenceCount: number,
  rawSkipRate: number | null,
  negative: NegativeSignals,
  reasons: DiscoveryScoreReason[],
): void {
  if (extendedEvidenceCount <= 0) return;
  if (negative.adjustedExplicitSkipRate >= 0.45) {
    reasons.push({
      code: "HIGH_EXPLICIT_SKIP_RATE",
      detail: `${explicitSkipCount}/${extendedEvidenceCount} explicit skips; adjusted rate=${negative.adjustedExplicitSkipRate.toFixed(2)}, penalty=${negative.penalty.toFixed(2)}.`,
    });
  } else if (negative.penalty > 0) {
    reasons.push({
      code: "ELEVATED_EXPLICIT_SKIP_RATE",
      detail: `${explicitSkipCount}/${extendedEvidenceCount} explicit skips; adjusted rate=${negative.adjustedExplicitSkipRate.toFixed(2)}, penalty=${negative.penalty.toFixed(2)}.`,
    });
  } else if (rawSkipRate !== null && rawSkipRate <= 0.1 && extendedEvidenceCount >= 20) {
    reasons.push({
      code: "LOW_EXPLICIT_SKIP_RATE",
      detail: `${explicitSkipCount}/${extendedEvidenceCount} explicit skips.`,
    });
  }
}

function addTrackHistoryReason(
  track: DiscoveryTrackProfile,
  trackHistory: number,
  reasons: DiscoveryScoreReason[],
): void {
  if (trackHistory >= 0.65) {
    reasons.push({
      code: "HIGH_HISTORICAL_AFFINITY",
      detail: `Track history strength=${trackHistory.toFixed(2)} across ${track.distinctListeningDays} listening days.`,
    });
  } else if (trackHistory > 0) {
    reasons.push({
      code: "TRACK_HISTORY_SUPPORT",
      detail: `Track history strength=${trackHistory.toFixed(2)} across ${track.distinctListeningDays} listening days.`,
    });
  }
}

function scoreNegativeSignals(
  explicitSkipCount: number,
  extendedEvidenceCount: number,
  inferredSkipCount: number,
  pendingInferredSkipCount: number,
): NegativeSignals {
  const adjustedExplicitSkipRate =
    (explicitSkipCount + SKIP_PRIOR_MEAN * SKIP_PRIOR_WEIGHT) /
    (extendedEvidenceCount + SKIP_PRIOR_WEIGHT);
  const explicitPenalty =
    extendedEvidenceCount <= 0
      ? 0
      : clamp01(
          (adjustedExplicitSkipRate - DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.neutralRate) /
            (DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.strongNegativeRate -
              DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.neutralRate),
        );
  const inferredPenalty = saturating(
    inferredSkipCount,
    DISCOVERY_SCORE_CALIBRATION.scales.inferredSkipCount,
  );
  const pendingPenalty = saturating(
    pendingInferredSkipCount,
    DISCOVERY_SCORE_CALIBRATION.scales.pendingInferredSkipCount,
  );
  return {
    adjustedExplicitSkipRate,
    penalty: clamp01(0.85 * explicitPenalty + 0.1 * inferredPenalty + 0.05 * pendingPenalty),
  };
}

function trackHistoricalStrength(track: DiscoveryTrackProfile): number {
  return clamp01(
    0.65 *
      saturating(track.playCount, DISCOVERY_SCORE_CALIBRATION.scales.trackHistoricalPlays) +
      0.35 *
        saturating(
          track.distinctListeningDays,
          DISCOVERY_SCORE_CALIBRATION.scales.trackHistoricalDays,
        ),
  );
}

function wholeDaysBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86_400_000));
}

function saturating(value: number, scale: number): number {
  if (value <= 0) return 0;
  return 1 - Math.exp(-value / scale);
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function score100(value: number): number {
  return Math.round(clamp01(value) * 1_000) / 10;
}

function rankEligibleInPlace<T extends { score: number }>(items: T[], count: number): T[] {
  items.sort((a, b) => b.score - a.score);
  if (items.length > count) items.length = count;
  return items;
}
