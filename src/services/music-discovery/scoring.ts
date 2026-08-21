import type {
  DiscoveryArtistProfile,
  DiscoveryTrackProfile,
} from "./profile";

const MIN_REDISCOVERY_TRACK_PLAYS = 3;
const SKIP_PRIOR_MEAN = 0.18;
const SKIP_PRIOR_WEIGHT = 12;

export const DISCOVERY_SCORE_CALIBRATION = {
  version: "gate2.1-v1",
  scales: {
    artistHistoricalPlays: 150,
    artistHistoricalDays: 100,
    artistRecent30dPlays: 16,
    artistRecent30dDays: 5,
    artistRecent90dPlays: 40,
    artistMomentumDelta: 15,
    artistMomentumDayDelta: 4,
    artistCatalogBreadth: 80,
    trackHistoricalPlays: 40,
    trackHistoricalDays: 30,
    inferredSkipCount: 3,
    pendingInferredSkipCount: 2,
    rediscoveryExtraDays: 365,
  },
  skipBayesPrior: {
    mean: SKIP_PRIOR_MEAN,
    weight: SKIP_PRIOR_WEIGHT,
    neutralRate: 0.12,
    elevatedRate: 0.18,
    strongNegativeRate: 0.65,
  },
  weights: {
    artistHistoricalAffinity: { plays: 0.55, listeningDays: 0.45 },
    artistRecentAffinity: { plays30d: 0.45, listeningDays30d: 0.4, plays90d: 0.15 },
    artistMomentum: { playDelta30d: 0.65, listeningDayDelta30d: 0.35 },
    artistAffinity: { historical: 0.75, recent: 0.18, momentum: 0.07, negativePenalty: -0.35 },
    familiarTrack: { trackHistory: 0.67, artistHistory: 0.25, artistRecent: 0.08, negativePenalty: -0.4 },
    rediscoveryTrack: { trackHistory: 0.45, artistHistory: 0.25, dormancy: 0.25, artistRecent: 0.05, negativePenalty: -0.35 },
    rediscoveryReturn: { historical: 0.45, recent: 0.2, dormancy: 0.2, momentum: 0.15, negativePenalty: -0.35 },
    deepeningArtist: { historical: 0.45, recent: 0.25, momentum: 0.15, catalogBreadth: 0.15, negativePenalty: -0.4 },
    externalDiscovery: { similarity: 0.5, seedArtistAffinity: 0.3, seedTrackAffinity: 0.1, sourceConfidence: 0.1 },
  },
  thresholds: {
    momentumMinListeningDays: 3,
    rediscoveryMinPriorPlays: 10,
    rediscoveryMinRecentPlays: 2,
    rediscoveryMinGapDays: 180,
    rediscoveryMinTrackPlays: MIN_REDISCOVERY_TRACK_PLAYS,
    minimumScores: {
      familiar: 55,
      rediscovery: 55,
      rediscoveryReturn: 40,
      deepening: 45,
      externalDiscovery: 55,
    },
  },
  note:
    "Gate 2.1 keeps Gate 2 weights, adds category arbitration, explainability, score floors and an explicit complete-universe contract. Scores remain read-only.",
} as const;

export type DiscoveryScoreReasonCode =
  | "HIGH_HISTORICAL_AFFINITY"
  | "TRACK_HISTORY_SUPPORT"
  | "STRONG_LISTENING_DAY_DEPTH"
  | "RECENT_INTEREST"
  | "POSITIVE_MOMENTUM"
  | "LOW_EXPLICIT_SKIP_RATE"
  | "ELEVATED_EXPLICIT_SKIP_RATE"
  | "HIGH_EXPLICIT_SKIP_RATE"
  | "INFERRED_SKIP_SIGNAL"
  | "LONG_DORMANCY"
  | "REDISCOVERY_RETURN"
  | "CATALOG_BREADTH"
  | "ALBUM_DEEPENING_SIGNAL"
  | "COOLDOWN_BLOCKED"
  | "COOLDOWN_UNKNOWN"
  | "INSUFFICIENT_HISTORY"
  | "CATEGORY_MINIMUM_NOT_MET"
  | "KNOWN_HISTORY_NOT_NEW"
  | "HIGH_SIMILARITY"
  | "STRONG_SEED_AFFINITY";

export type DiscoveryScoreReason = {
  code: DiscoveryScoreReasonCode;
  detail: string;
};

export type DiscoveryArtistScoreComponents = {
  historicalAffinity: number;
  recentAffinity: number;
  momentum: number;
  catalogBreadth: number;
  adjustedExplicitSkipRate: number;
  negativePenalty: number;
};

export type DiscoveryArtistScoreCard = {
  artistName: string;
  score: number;
  components: DiscoveryArtistScoreComponents;
  reasons: DiscoveryScoreReason[];
};

export type DiscoveryTrackScoreComponents = {
  trackHistoricalStrength: number;
  artistHistoricalAffinity: number;
  artistRecentAffinity: number;
  dormancy: number;
  adjustedExplicitSkipRate: number;
  negativePenalty: number;
};

export type DiscoveryScoredTrackCandidate = {
  category: "FAMILIAR" | "REDESCOBERTA";
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  score: number;
  eligible: boolean;
  components: DiscoveryTrackScoreComponents;
  reasons: DiscoveryScoreReason[];
};

export type DiscoveryScoredArtistCandidate = {
  category: "REDISCOVERY_RETURN" | "APROFUNDAMENTO";
  artistName: string;
  score: number;
  eligible: boolean;
  components: DiscoveryArtistScoreComponents & { rediscoveryDormancy: number };
  reasons: DiscoveryScoreReason[];
};

export type DiscoveryCandidateProvenance =
  | "LASTFM_SIMILAR_ARTIST"
  | "LASTFM_SIMILAR_TRACK"
  | "LASTFM_TAG"
  | "NEW_RELEASE"
  | "OTHER";

export type ExternalDiscoveryCandidateInput = {
  candidateKey: string;
  artistName: string;
  source: DiscoveryCandidateProvenance;
  similarity: number;
  seedArtistAffinity: number;
  seedTrackAffinity?: number | null;
  sourceConfidence?: number;
  knownHistoricalPlayCount: number;
};

export type ExternalDiscoveryCandidateScore = {
  category: "DESCOBERTA";
  candidateKey: string;
  artistName: string;
  source: DiscoveryCandidateProvenance;
  score: number;
  eligible: boolean;
  components: {
    similarity: number;
    seedArtistAffinity: number;
    seedTrackAffinity: number;
    sourceConfidence: number;
  };
  reasons: DiscoveryScoreReason[];
};

export type DiscoveryCandidateUniverse = "COMPLETE" | "DIAGNOSTIC_PARTIAL";

export type DiscoveryScoringReport = {
  version: string;
  generatedAt: Date;
  calibration: typeof DISCOVERY_SCORE_CALIBRATION;
  selectionPolicy: {
    candidateUniverse: DiscoveryCandidateUniverse;
    selectionReady: boolean;
    categoryBudgetRule: "CEILING_NOT_QUOTA";
    trackCategoryPrecedence: readonly ["REDESCOBERTA", "FAMILIAR"];
    rediscoveryPreemptedFamiliarCount: number;
    minimumScores: typeof DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores;
  };
  topArtistAffinity: DiscoveryArtistScoreCard[];
  familiarCandidates: DiscoveryScoredTrackCandidate[];
  rediscoveryCandidates: DiscoveryScoredTrackCandidate[];
  rediscoveryReturns: DiscoveryScoredArtistCandidate[];
  deepeningCandidates: DiscoveryScoredArtistCandidate[];
  externalDiscovery: {
    status: "READY_FOR_CANDIDATES";
    note: string;
  };
};

export type BuildDiscoveryScoringInput = {
  generatedAt: Date;
  dormantDays: number;
  rediscoveryGapDays: number;
  topN: number;
  artists: DiscoveryArtistProfile[];
  tracks: DiscoveryTrackProfile[];
  candidateUniverse?: DiscoveryCandidateUniverse;
};

type NegativeSignals = {
  adjustedExplicitSkipRate: number;
  penalty: number;
};

export function buildDiscoveryScoringReport(
  input: BuildDiscoveryScoringInput,
): DiscoveryScoringReport {
  const candidateUniverse = input.candidateUniverse ?? "COMPLETE";
  const artistCards = input.artists.map(scoreArtistProfile);
  const artistByKey = new Map(
    artistCards.map((artist) => [normalized(artist.artistName), artist] as const),
  );

  const topArtistAffinity = topByScore(artistCards, input.topN);

  const scoredRediscoveryTracks = input.tracks.map((track) =>
    scoreRediscoveryTrack(track, artistByKey, input.generatedAt, input.dormantDays),
  );
  const rediscoveryEligibleIds = new Set(
    scoredRediscoveryTracks
      .filter((candidate) => candidate.eligible)
      .map((candidate) => candidate.spotifyTrackId),
  );
  const rediscoveryCandidates = topByScore(
    scoredRediscoveryTracks.filter((candidate) => candidate.eligible),
    input.topN,
  );

  const scoredFamiliarTracks = input.tracks.map((track) =>
    scoreFamiliarTrack(track, artistByKey),
  );
  const preemptedFamiliarCount = scoredFamiliarTracks.filter(
    (candidate) =>
      candidate.eligible && rediscoveryEligibleIds.has(candidate.spotifyTrackId),
  ).length;
  const familiarCandidates = topByScore(
    scoredFamiliarTracks.filter(
      (candidate) =>
        candidate.eligible && !rediscoveryEligibleIds.has(candidate.spotifyTrackId),
    ),
    input.topN,
  );

  const rediscoveryReturns = topByScore(
    input.artists
      .map((artist) =>
        scoreRediscoveryReturn(
          artist,
          artistByKey.get(normalized(artist.artistName))!,
          input.rediscoveryGapDays,
        ),
      )
      .filter((candidate) => candidate.eligible),
    input.topN,
  );
  const deepeningCandidates = topByScore(
    input.artists
      .map((artist) =>
        scoreDeepeningArtist(
          artist,
          artistByKey.get(normalized(artist.artistName))!,
        ),
      )
      .filter((candidate) => candidate.eligible),
    input.topN,
  );

  return {
    version: DISCOVERY_SCORE_CALIBRATION.version,
    generatedAt: new Date(input.generatedAt),
    calibration: DISCOVERY_SCORE_CALIBRATION,
    selectionPolicy: {
      candidateUniverse,
      selectionReady: candidateUniverse === "COMPLETE",
      categoryBudgetRule: "CEILING_NOT_QUOTA",
      trackCategoryPrecedence: ["REDESCOBERTA", "FAMILIAR"],
      rediscoveryPreemptedFamiliarCount: preemptedFamiliarCount,
      minimumScores: DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores,
    },
    topArtistAffinity,
    familiarCandidates,
    rediscoveryCandidates,
    rediscoveryReturns,
    deepeningCandidates,
    externalDiscovery: {
      status: "READY_FOR_CANDIDATES",
      note:
        "DESCOBERTA scoring is implemented as a pure candidate contract. Candidate acquisition/similarity calls remain a separate gate; known history is never labeled as new discovery.",
    },
  };
}

export function assertDiscoverySelectionReady(report: DiscoveryScoringReport): void {
  if (!report.selectionPolicy.selectionReady) {
    throw new Error(
      "DISCOVERY selection requires candidateUniverse=COMPLETE; diagnostic partial pools cannot drive planner selection.",
    );
  }
}

export function scoreArtistProfile(
  artist: DiscoveryArtistProfile,
): DiscoveryArtistScoreCard {
  const historicalAffinity = clamp01(
    DISCOVERY_SCORE_CALIBRATION.weights.artistHistoricalAffinity.plays *
      saturating(artist.playCount, DISCOVERY_SCORE_CALIBRATION.scales.artistHistoricalPlays) +
      DISCOVERY_SCORE_CALIBRATION.weights.artistHistoricalAffinity.listeningDays *
        saturating(
          artist.distinctListeningDays,
          DISCOVERY_SCORE_CALIBRATION.scales.artistHistoricalDays,
        ),
  );
  const recentAffinity = clamp01(
    DISCOVERY_SCORE_CALIBRATION.weights.artistRecentAffinity.plays30d *
      saturating(artist.plays30d, DISCOVERY_SCORE_CALIBRATION.scales.artistRecent30dPlays) +
      DISCOVERY_SCORE_CALIBRATION.weights.artistRecentAffinity.listeningDays30d *
        saturating(
          artist.listeningDays30d,
          DISCOVERY_SCORE_CALIBRATION.scales.artistRecent30dDays,
        ) +
      DISCOVERY_SCORE_CALIBRATION.weights.artistRecentAffinity.plays90d *
        saturating(artist.plays90d, DISCOVERY_SCORE_CALIBRATION.scales.artistRecent90dPlays),
  );
  const momentum =
    artist.listeningDays30d <
    DISCOVERY_SCORE_CALIBRATION.thresholds.momentumMinListeningDays
      ? 0
      : clamp01(
          DISCOVERY_SCORE_CALIBRATION.weights.artistMomentum.playDelta30d *
            saturating(
              Math.max(0, artist.momentumDelta30d),
              DISCOVERY_SCORE_CALIBRATION.scales.artistMomentumDelta,
            ) +
            DISCOVERY_SCORE_CALIBRATION.weights.artistMomentum.listeningDayDelta30d *
              saturating(
                Math.max(0, artist.momentumListeningDayDelta30d),
                DISCOVERY_SCORE_CALIBRATION.scales.artistMomentumDayDelta,
              ),
        );
  const catalogBreadth = saturating(
    artist.distinctTrackCount,
    DISCOVERY_SCORE_CALIBRATION.scales.artistCatalogBreadth,
  );
  const negative = scoreNegativeSignals(
    artist.explicitSkipCount,
    artist.extendedEvidenceCount,
    artist.inferredSkipCount,
    artist.pendingInferredSkipCount,
  );
  const unitScore = clamp01(
    DISCOVERY_SCORE_CALIBRATION.weights.artistAffinity.historical * historicalAffinity +
      DISCOVERY_SCORE_CALIBRATION.weights.artistAffinity.recent * recentAffinity +
      DISCOVERY_SCORE_CALIBRATION.weights.artistAffinity.momentum * momentum +
      DISCOVERY_SCORE_CALIBRATION.weights.artistAffinity.negativePenalty * negative.penalty,
  );
  const reasons = commonArtistReasons(
    artist,
    historicalAffinity,
    recentAffinity,
    momentum,
    catalogBreadth,
    negative,
  );

  return {
    artistName: artist.artistName,
    score: score100(unitScore),
    components: {
      historicalAffinity: rounded(historicalAffinity),
      recentAffinity: rounded(recentAffinity),
      momentum: rounded(momentum),
      catalogBreadth: rounded(catalogBreadth),
      adjustedExplicitSkipRate: rounded(negative.adjustedExplicitSkipRate),
      negativePenalty: rounded(negative.penalty),
    },
    reasons,
  };
}

export function scoreExternalDiscoveryCandidate(
  candidate: ExternalDiscoveryCandidateInput,
): ExternalDiscoveryCandidateScore {
  const similarity = unit(candidate.similarity, "similarity");
  const seedArtistAffinity = unit(candidate.seedArtistAffinity, "seedArtistAffinity");
  const seedTrackAffinity = unit(
    candidate.seedTrackAffinity ?? candidate.seedArtistAffinity,
    "seedTrackAffinity",
  );
  const sourceConfidence = unit(candidate.sourceConfidence ?? 0.8, "sourceConfidence");
  const reasons: DiscoveryScoreReason[] = [];

  if (candidate.knownHistoricalPlayCount > 0) {
    reasons.push({
      code: "KNOWN_HISTORY_NOT_NEW",
      detail: `${candidate.knownHistoricalPlayCount} historical plays already exist for this candidate.`,
    });
    return {
      category: "DESCOBERTA",
      candidateKey: candidate.candidateKey,
      artistName: candidate.artistName,
      source: candidate.source,
      score: 0,
      eligible: false,
      components: { similarity, seedArtistAffinity, seedTrackAffinity, sourceConfidence },
      reasons,
    };
  }

  if (similarity >= 0.7) {
    reasons.push({ code: "HIGH_SIMILARITY", detail: `Similarity=${similarity.toFixed(2)}.` });
  }
  if (seedArtistAffinity >= 0.65) {
    reasons.push({
      code: "STRONG_SEED_AFFINITY",
      detail: `Seed artist affinity=${seedArtistAffinity.toFixed(2)}.`,
    });
  }

  const weights = DISCOVERY_SCORE_CALIBRATION.weights.externalDiscovery;
  const score = score100(
    clamp01(
      weights.similarity * similarity +
        weights.seedArtistAffinity * seedArtistAffinity +
        weights.seedTrackAffinity * seedTrackAffinity +
        weights.sourceConfidence * sourceConfidence,
    ),
  );
  const eligible =
    score >= DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.externalDiscovery;
  if (!eligible) addMinimumScoreReason("DESCOBERTA", score, reasons);

  return {
    category: "DESCOBERTA",
    candidateKey: candidate.candidateKey,
    artistName: candidate.artistName,
    source: candidate.source,
    score,
    eligible,
    components: { similarity, seedArtistAffinity, seedTrackAffinity, sourceConfidence },
    reasons,
  };
}

function scoreFamiliarTrack(
  track: DiscoveryTrackProfile,
  artistByKey: Map<string, DiscoveryArtistScoreCard>,
): DiscoveryScoredTrackCandidate {
  const artist = artistByKey.get(normalized(track.artistName));
  const trackHistory = trackHistoricalStrength(track);
  const negative = scoreNegativeSignals(
    track.explicitSkipCount,
    track.extendedEvidenceCount,
    track.inferredSkipCount,
    track.pendingInferredSkipCount,
  );
  const reasons: DiscoveryScoreReason[] = [];

  if (track.cooldownEligible === false) {
    reasons.push({ code: "COOLDOWN_BLOCKED", detail: "MUSIC-01 cooldown is currently active." });
  } else if (track.cooldownEligible === null) {
    reasons.push({ code: "COOLDOWN_UNKNOWN", detail: "MUSIC-01 cooldown eligibility is unknown." });
  }
  addTrackQualityReasons(track, negative, reasons);
  addTrackHistoryReason(track, trackHistory, reasons);

  const weights = DISCOVERY_SCORE_CALIBRATION.weights.familiarTrack;
  const score = score100(
    clamp01(
      weights.trackHistory * trackHistory +
        weights.artistHistory * (artist?.components.historicalAffinity ?? 0) +
        weights.artistRecent * (artist?.components.recentAffinity ?? 0) +
        weights.negativePenalty * negative.penalty,
    ),
  );
  const baseEligible = track.cooldownEligible === true;
  const eligible =
    baseEligible && score >= DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.familiar;
  if (baseEligible && !eligible) addMinimumScoreReason("FAMILIAR", score, reasons);

  return {
    category: "FAMILIAR",
    spotifyTrackId: track.spotifyTrackId,
    trackName: track.trackName,
    artistName: track.artistName,
    score: baseEligible ? score : 0,
    eligible,
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

function scoreRediscoveryTrack(
  track: DiscoveryTrackProfile,
  artistByKey: Map<string, DiscoveryArtistScoreCard>,
  generatedAt: Date,
  dormantDays: number,
): DiscoveryScoredTrackCandidate {
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
  const reasons: DiscoveryScoreReason[] = [];
  const baseEligible =
    track.cooldownEligible === true &&
    daysSinceLastPlay >= dormantDays &&
    track.playCount >= DISCOVERY_SCORE_CALIBRATION.thresholds.rediscoveryMinTrackPlays;

  if (track.cooldownEligible === false) {
    reasons.push({ code: "COOLDOWN_BLOCKED", detail: "MUSIC-01 cooldown is currently active." });
  } else if (track.cooldownEligible === null) {
    reasons.push({ code: "COOLDOWN_UNKNOWN", detail: "MUSIC-01 cooldown eligibility is unknown." });
  }
  if (daysSinceLastPlay >= dormantDays) {
    reasons.push({
      code: "LONG_DORMANCY",
      detail: `${daysSinceLastPlay} days since the last observed play.`,
    });
  }
  if (track.playCount < DISCOVERY_SCORE_CALIBRATION.thresholds.rediscoveryMinTrackPlays) {
    reasons.push({
      code: "INSUFFICIENT_HISTORY",
      detail: `Only ${track.playCount} historical plays; redescoberta requires at least ${DISCOVERY_SCORE_CALIBRATION.thresholds.rediscoveryMinTrackPlays}.`,
    });
  }
  addTrackQualityReasons(track, negative, reasons);
  addTrackHistoryReason(track, trackHistory, reasons);

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
    baseEligible && score >= DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.rediscovery;
  if (baseEligible && !eligible) addMinimumScoreReason("REDESCOBERTA", score, reasons);

  return {
    category: "REDESCOBERTA",
    spotifyTrackId: track.spotifyTrackId,
    trackName: track.trackName,
    artistName: track.artistName,
    score: baseEligible ? score : 0,
    eligible,
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

function scoreRediscoveryReturn(
  artist: DiscoveryArtistProfile,
  affinity: DiscoveryArtistScoreCard,
  rediscoveryGapDays: number,
): DiscoveryScoredArtistCandidate {
  const gap = artist.rediscoveryGapDays ?? 0;
  const baseEligible =
    artist.priorPlayCount >= DISCOVERY_SCORE_CALIBRATION.thresholds.rediscoveryMinPriorPlays &&
    artist.plays30d >= DISCOVERY_SCORE_CALIBRATION.thresholds.rediscoveryMinRecentPlays &&
    gap >= rediscoveryGapDays;
  const rediscoveryDormancy =
    gap >= rediscoveryGapDays
      ? clamp01(
          0.25 +
            0.75 *
              saturating(
                gap - rediscoveryGapDays,
                DISCOVERY_SCORE_CALIBRATION.scales.rediscoveryExtraDays,
              ),
        )
      : 0;
  const reasons = [...affinity.reasons];
  if (baseEligible) {
    reasons.push({
      code: "REDISCOVERY_RETURN",
      detail: `${artist.priorPlayCount} prior plays, ${artist.plays30d} plays in 30d after a ${gap}-day gap.`,
    });
  } else if (artist.priorPlayCount < DISCOVERY_SCORE_CALIBRATION.thresholds.rediscoveryMinPriorPlays) {
    reasons.push({
      code: "INSUFFICIENT_HISTORY",
      detail: `Only ${artist.priorPlayCount} prior plays; return needs historical depth.`,
    });
  }

  const weights = DISCOVERY_SCORE_CALIBRATION.weights.rediscoveryReturn;
  const components = affinity.components;
  const score = score100(
    clamp01(
      weights.historical * components.historicalAffinity +
        weights.recent * components.recentAffinity +
        weights.dormancy * rediscoveryDormancy +
        weights.momentum * components.momentum +
        weights.negativePenalty * components.negativePenalty,
    ),
  );
  const eligible =
    baseEligible &&
    score >= DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.rediscoveryReturn;
  if (baseEligible && !eligible) addMinimumScoreReason("REDISCOVERY_RETURN", score, reasons);

  return {
    category: "REDISCOVERY_RETURN",
    artistName: artist.artistName,
    score: baseEligible ? score : 0,
    eligible,
    components: { ...components, rediscoveryDormancy: rounded(rediscoveryDormancy) },
    reasons,
  };
}

function scoreDeepeningArtist(
  artist: DiscoveryArtistProfile,
  affinity: DiscoveryArtistScoreCard,
): DiscoveryScoredArtistCandidate {
  const reasons = [...affinity.reasons];
  const components = affinity.components;
  const weights = DISCOVERY_SCORE_CALIBRATION.weights.deepeningArtist;
  const score = score100(
    clamp01(
      weights.historical * components.historicalAffinity +
        weights.recent * components.recentAffinity +
        weights.momentum * components.momentum +
        weights.catalogBreadth * components.catalogBreadth +
        weights.negativePenalty * components.negativePenalty,
    ),
  );
  const eligible = score >= DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.deepening;

  if (eligible) {
    reasons.push({
      code: "ALBUM_DEEPENING_SIGNAL",
      detail: `${artist.distinctTrackCount} distinct tracks observed; ALBUM-01 can combine this artist signal with album coverage.`,
    });
  } else if (score > 0) {
    addMinimumScoreReason("APROFUNDAMENTO", score, reasons);
  }

  return {
    category: "APROFUNDAMENTO",
    artistName: artist.artistName,
    score,
    eligible,
    components: { ...components, rediscoveryDormancy: 0 },
    reasons,
  };
}

function commonArtistReasons(
  artist: DiscoveryArtistProfile,
  historicalAffinity: number,
  recentAffinity: number,
  momentum: number,
  catalogBreadth: number,
  negative: NegativeSignals,
): DiscoveryScoreReason[] {
  const reasons: DiscoveryScoreReason[] = [];
  if (historicalAffinity >= 0.65) {
    reasons.push({
      code: "HIGH_HISTORICAL_AFFINITY",
      detail: `${artist.playCount} plays across ${artist.distinctListeningDays} listening days.`,
    });
  }
  if (artist.distinctListeningDays >= 60) {
    reasons.push({
      code: "STRONG_LISTENING_DAY_DEPTH",
      detail: `${artist.distinctListeningDays} distinct listening days.`,
    });
  }
  if (recentAffinity >= 0.5) {
    reasons.push({
      code: "RECENT_INTEREST",
      detail: `${artist.plays30d} plays across ${artist.listeningDays30d} days in the last 30 days.`,
    });
  }
  if (momentum >= 0.35) {
    reasons.push({
      code: "POSITIVE_MOMENTUM",
      detail: `30d delta=${artist.momentumDelta30d}, listening-day delta=${artist.momentumListeningDayDelta30d}.`,
    });
  }
  addNegativeReason(
    artist.explicitSkipCount,
    artist.extendedEvidenceCount,
    artist.explicitSkipRate,
    negative,
    reasons,
  );
  if (artist.inferredSkipCount > 0) {
    reasons.push({
      code: "INFERRED_SKIP_SIGNAL",
      detail: `${artist.inferredSkipCount} inferred skips (${artist.pendingInferredSkipCount} pending).`,
    });
  }
  if (catalogBreadth >= 0.5) {
    reasons.push({
      code: "CATALOG_BREADTH",
      detail: `${artist.distinctTrackCount} distinct tracks observed.`,
    });
  }
  return reasons;
}

function addTrackQualityReasons(
  track: DiscoveryTrackProfile,
  negative: NegativeSignals,
  reasons: DiscoveryScoreReason[],
) {
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
) {
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
) {
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

function addMinimumScoreReason(
  category: "FAMILIAR" | "REDESCOBERTA" | "REDISCOVERY_RETURN" | "APROFUNDAMENTO" | "DESCOBERTA",
  score: number,
  reasons: DiscoveryScoreReason[],
) {
  const minimum =
    category === "FAMILIAR"
      ? DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.familiar
      : category === "REDESCOBERTA"
        ? DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.rediscovery
        : category === "REDISCOVERY_RETURN"
          ? DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.rediscoveryReturn
          : category === "APROFUNDAMENTO"
            ? DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.deepening
            : DISCOVERY_SCORE_CALIBRATION.thresholds.minimumScores.externalDiscovery;
  reasons.push({
    code: "CATEGORY_MINIMUM_NOT_MET",
    detail: `${category} score=${score.toFixed(1)} is below the selection floor ${minimum.toFixed(1)}; the category may abstain instead of filling quota.`,
  });
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

function saturating(value: number, scale: number): number {
  if (value <= 0) return 0;
  return 1 - Math.exp(-value / scale);
}

function wholeDaysBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86_400_000));
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function unit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number between 0 and 1`);
  }
  return value;
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

function topByScore<T extends { score: number }>(items: T[], count: number): T[] {
  return [...items].sort((a, b) => b.score - a.score).slice(0, count);
}
