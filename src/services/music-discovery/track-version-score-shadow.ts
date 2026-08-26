import {
  classifyTrackVersion,
  type TrackVersionClassification,
  type TrackVersionClassificationResult,
} from "./track-version-preference";

export const TRACK_VERSION_SCORE_SHADOW_POLICY = {
  version: "music-version-gate3-shadow-v1",
  studioOrStandardMultiplier: 1,
  unknownMultiplier: 1,
  liveMultiplier: 0.9,
  rule: "PENALIZE_LIVE_WITHOUT_BLOCKING",
} as const;

export type TrackVersionScoreShadowCandidate = {
  candidateKey: string;
  artistName: string;
  trackName: string;
  albumName: string | null;
  rawScore: number;
};

export type TrackVersionScoreShadowRow = TrackVersionScoreShadowCandidate & {
  originalRank: number;
  shadowRank: number;
  adjustedScore: number;
  scoreDelta: number;
  multiplier: number;
  version: TrackVersionClassificationResult;
};

export type TrackVersionScoreShadowReport = {
  generatedAt: Date;
  policy: typeof TRACK_VERSION_SCORE_SHADOW_POLICY;
  safety: {
    shadowOnly: true;
    plannerInfluence: false;
    databaseWrites: false;
    spotifyWrites: false;
  };
  totals: {
    candidates: number;
    liveCandidates: number;
    penalizedCandidates: number;
    changedRankCandidates: number;
  };
  originalOrder: TrackVersionScoreShadowRow[];
  shadowOrder: TrackVersionScoreShadowRow[];
};

export function trackVersionScoreMultiplier(
  classification: TrackVersionClassification,
): number {
  if (classification === "LIVE") {
    return TRACK_VERSION_SCORE_SHADOW_POLICY.liveMultiplier;
  }
  if (classification === "UNKNOWN") {
    return TRACK_VERSION_SCORE_SHADOW_POLICY.unknownMultiplier;
  }
  return TRACK_VERSION_SCORE_SHADOW_POLICY.studioOrStandardMultiplier;
}

export function adjustScoreForTrackVersionShadow(input: {
  rawScore: number;
  trackName: string;
  albumName?: string | null;
}): {
  adjustedScore: number;
  scoreDelta: number;
  multiplier: number;
  version: TrackVersionClassificationResult;
} {
  if (!Number.isFinite(input.rawScore)) {
    throw new Error("rawScore must be finite");
  }

  const version = classifyTrackVersion({
    trackName: input.trackName,
    albumName: input.albumName ?? null,
  });
  const multiplier = trackVersionScoreMultiplier(version.classification);
  const adjustedScore = round3(input.rawScore * multiplier);

  return {
    adjustedScore,
    scoreDelta: round3(adjustedScore - input.rawScore),
    multiplier,
    version,
  };
}

export function buildTrackVersionScoreShadowReport(
  candidates: TrackVersionScoreShadowCandidate[],
): TrackVersionScoreShadowReport {
  const source = candidates.map((candidate, index) => {
    const adjustment = adjustScoreForTrackVersionShadow(candidate);
    return {
      ...candidate,
      originalRank: index + 1,
      shadowRank: 0,
      ...adjustment,
    };
  });

  const ranked = [...source].sort((left, right) => {
    if (right.adjustedScore !== left.adjustedScore) {
      return right.adjustedScore - left.adjustedScore;
    }
    if (right.rawScore !== left.rawScore) {
      return right.rawScore - left.rawScore;
    }
    return left.originalRank - right.originalRank;
  });

  ranked.forEach((row, index) => {
    row.shadowRank = index + 1;
  });

  const byKey = new Map(ranked.map((row) => [row.candidateKey, row] as const));
  const originalOrder = source.map((row) => byKey.get(row.candidateKey) ?? row);

  return {
    generatedAt: new Date(),
    policy: TRACK_VERSION_SCORE_SHADOW_POLICY,
    safety: {
      shadowOnly: true,
      plannerInfluence: false,
      databaseWrites: false,
      spotifyWrites: false,
    },
    totals: {
      candidates: source.length,
      liveCandidates: source.filter((row) => row.version.classification === "LIVE").length,
      penalizedCandidates: source.filter((row) => row.multiplier < 1).length,
      changedRankCandidates: source.filter((row) => row.originalRank !== row.shadowRank).length,
    },
    originalOrder,
    shadowOrder: ranked,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
