import type { AlbumCoverageFacts } from "./profile";

const SKIP_PRIOR_MEAN = 0.18;
const SKIP_PRIOR_WEIGHT = 8;

export const ALBUM_OPPORTUNITY_POLICY = {
  version: "album-gate2-opportunity-readonly-v1",
  weights: {
    artistDeepening: 0.45,
    unexploredCoverage: 0.4,
    recentAlbumActivity: 0.15,
  },
  albumSkipPenalty: {
    priorMean: SKIP_PRIOR_MEAN,
    priorWeight: SKIP_PRIOR_WEIGHT,
    neutralRate: 0.18,
    strongNegativeRate: 0.65,
    maxPenalty: 15,
  },
  recentActivityScalePlays30d: 3,
  note:
    "Gate 2 ranks exact Spotify album editions read-only. DISCOVERY-01 remains authority for artist affinity; ALBUM-01 adds album coverage, recent album activity and album-specific negative evidence.",
} as const;

export type AlbumOpportunityReasonCode =
  | "HIGH_ARTIST_DEEPENING"
  | "NO_ALBUM_HISTORY"
  | "LOW_ALBUM_COVERAGE"
  | "MODERATE_ALBUM_COVERAGE"
  | "ALBUM_MOSTLY_KNOWN"
  | "ALBUM_FULLY_OBSERVED"
  | "RECENT_ALBUM_ACTIVITY"
  | "ELEVATED_ALBUM_SKIP_RATE"
  | "STRONG_ALBUM_SKIP_RATE"
  | "LABEL_ONLY_COVERAGE_EVIDENCE"
  | "MIXED_COVERAGE_EVIDENCE";

export type AlbumOpportunityReason = {
  code: AlbumOpportunityReasonCode;
  detail: string;
};

export type AlbumOpportunityComponents = {
  artistDeepening: number;
  unexploredCoverage: number;
  recentAlbumActivity: number;
  adjustedExplicitSkipRate: number;
  negativePenalty: number;
};

export type AlbumOpportunityCandidate = {
  spotifyAlbumId: string;
  albumName: string;
  releaseDate: string | null;
  artistName: string;
  artistDeepeningScore: number;
  score: number;
  eligible: boolean;
  coverage: AlbumCoverageFacts;
  components: AlbumOpportunityComponents;
  reasons: AlbumOpportunityReason[];
};

export function scoreAlbumOpportunity(input: {
  artistName: string;
  artistDeepeningScore: number;
  coverage: AlbumCoverageFacts;
}): AlbumOpportunityCandidate {
  const coverage = input.coverage;
  const analyticCoverage = coverage.analyticCoverage ?? 1;
  const artistDeepening = clamp01(input.artistDeepeningScore / 100);
  const unexploredCoverage = clamp01(1 - analyticCoverage);
  const recentAlbumActivity = clamp01(
    coverage.plays30d / ALBUM_OPPORTUNITY_POLICY.recentActivityScalePlays30d,
  );
  const adjustedExplicitSkipRate = adjustedSkipRate(
    coverage.explicitSkipEventCount,
    coverage.matchedEventCount,
  );
  const negativePenalty = skipPenalty(adjustedExplicitSkipRate);

  const weighted =
    artistDeepening * ALBUM_OPPORTUNITY_POLICY.weights.artistDeepening * 100 +
    unexploredCoverage * ALBUM_OPPORTUNITY_POLICY.weights.unexploredCoverage * 100 +
    recentAlbumActivity * ALBUM_OPPORTUNITY_POLICY.weights.recentAlbumActivity * 100 -
    negativePenalty;

  return {
    spotifyAlbumId: coverage.spotifyAlbumId,
    albumName: coverage.albumName,
    releaseDate: coverage.releaseDate,
    artistName: input.artistName,
    artistDeepeningScore: round1(input.artistDeepeningScore),
    score: round1(Math.max(0, weighted)),
    eligible: coverage.eligibleTrackCount > 0,
    coverage,
    components: {
      artistDeepening: round4(artistDeepening),
      unexploredCoverage: round4(unexploredCoverage),
      recentAlbumActivity: round4(recentAlbumActivity),
      adjustedExplicitSkipRate: round4(adjustedExplicitSkipRate),
      negativePenalty: round1(negativePenalty),
    },
    reasons: buildReasons({
      artistDeepeningScore: input.artistDeepeningScore,
      analyticCoverage,
      plays30d: coverage.plays30d,
      adjustedExplicitSkipRate,
      confidence: coverage.confidence,
    }),
  };
}

export function rankAlbumOpportunities(
  candidates: AlbumOpportunityCandidate[],
): AlbumOpportunityCandidate[] {
  return [...candidates]
    .filter((candidate) => candidate.eligible)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.coverage.analyticCoverage ?? 1) - (b.coverage.analyticCoverage ?? 1) ||
        b.coverage.plays30d - a.coverage.plays30d ||
        a.albumName.localeCompare(b.albumName) ||
        a.spotifyAlbumId.localeCompare(b.spotifyAlbumId),
    );
}

function buildReasons(input: {
  artistDeepeningScore: number;
  analyticCoverage: number;
  plays30d: number;
  adjustedExplicitSkipRate: number;
  confidence: AlbumCoverageFacts["confidence"];
}): AlbumOpportunityReason[] {
  const reasons: AlbumOpportunityReason[] = [];
  if (input.artistDeepeningScore >= 70) {
    reasons.push({
      code: "HIGH_ARTIST_DEEPENING",
      detail: `artist deepening score ${round1(input.artistDeepeningScore)}`,
    });
  }

  if (input.analyticCoverage === 0) {
    reasons.push({ code: "NO_ALBUM_HISTORY", detail: "0% observed album coverage" });
  } else if (input.analyticCoverage < 0.35) {
    reasons.push({
      code: "LOW_ALBUM_COVERAGE",
      detail: `${Math.round(input.analyticCoverage * 100)}% observed album coverage`,
    });
  } else if (input.analyticCoverage < 0.7) {
    reasons.push({
      code: "MODERATE_ALBUM_COVERAGE",
      detail: `${Math.round(input.analyticCoverage * 100)}% observed album coverage`,
    });
  } else if (input.analyticCoverage >= 0.95) {
    reasons.push({
      code: "ALBUM_FULLY_OBSERVED",
      detail: `${Math.round(input.analyticCoverage * 100)}% observed album coverage`,
    });
  } else if (input.analyticCoverage >= 0.8) {
    reasons.push({
      code: "ALBUM_MOSTLY_KNOWN",
      detail: `${Math.round(input.analyticCoverage * 100)}% observed album coverage`,
    });
  }

  if (input.plays30d > 0) {
    reasons.push({
      code: "RECENT_ALBUM_ACTIVITY",
      detail: `${input.plays30d} matched plays in the last 30 days`,
    });
  }

  if (input.adjustedExplicitSkipRate >= 0.65) {
    reasons.push({
      code: "STRONG_ALBUM_SKIP_RATE",
      detail: `adjusted explicit skip rate ${Math.round(input.adjustedExplicitSkipRate * 100)}%`,
    });
  } else if (input.adjustedExplicitSkipRate > 0.18) {
    reasons.push({
      code: "ELEVATED_ALBUM_SKIP_RATE",
      detail: `adjusted explicit skip rate ${Math.round(input.adjustedExplicitSkipRate * 100)}%`,
    });
  }

  if (input.confidence === "LABEL_ONLY") {
    reasons.push({
      code: "LABEL_ONLY_COVERAGE_EVIDENCE",
      detail: "coverage includes only id-less historical label matches",
    });
  } else if (input.confidence === "MIXED_CANONICAL_AND_LABEL") {
    reasons.push({
      code: "MIXED_COVERAGE_EVIDENCE",
      detail: "coverage combines canonical and id-less historical evidence",
    });
  }
  return reasons;
}

function adjustedSkipRate(skips: number, events: number): number {
  return (skips + SKIP_PRIOR_MEAN * SKIP_PRIOR_WEIGHT) / (events + SKIP_PRIOR_WEIGHT);
}

function skipPenalty(rate: number): number {
  const config = ALBUM_OPPORTUNITY_POLICY.albumSkipPenalty;
  const normalized = clamp01(
    (rate - config.neutralRate) / (config.strongNegativeRate - config.neutralRate),
  );
  return normalized * config.maxPenalty;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
