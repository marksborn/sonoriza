import {
  getLikedDiscoveryExpansionShadowReport,
  type LikedDiscoveryExpansionShadowReport,
  type LikedExpansionResolvedCandidate,
} from "./liked-discovery-expansion-shadow";
import type { LikedShadowRankedRecommendation } from "./liked-shadow-discovery";

export const LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY = {
  topPerCategory: 4,
  maxExploratorySlots: 1,
  externalScoreFloor: 55,
  externalScoreCompression: 0.45,
  maxAmbiguityRateForPilot: 0.5,
  minResolvedCandidatesForPilot: 4,
  nearDuplicateMinSeedTokens: 2,
} as const;

export type LikedCalibratedDiscoveryTopEntry = {
  source: "CURRENT_POOL" | "LIKED_EXPANSION";
  artistName: string;
  trackName: string;
  spotifyTrackId: string | null;
  signalKind: string;
  rawScore: number;
  calibratedScore: number;
  explanation: string | null;
};

export type LikedNearDuplicateDiagnostic = {
  artistName: string;
  providerArtistName: string;
  trackName: string;
  spotifyTrackId: string;
  rawScore: number;
  matchedSeedNames: string[];
  reason: "SEED_NAME_CONTAINMENT";
};

export type LikedDiscoveryCalibrationReadiness =
  | "READY_FOR_CONTROLLED_PILOT"
  | "KEEP_SHADOW";

export type LikedDiscoveryCalibrationShadowReport = {
  generatedAt: Date;
  policy: typeof LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY;
  safety: LikedDiscoveryExpansionShadowReport["safety"];
  sourceExpansion: {
    generatedAt: Date;
    baselineDiscoveryPoolSize: number;
    attempted: number;
    resolved: number;
    ambiguous: number;
    ambiguityRate: number;
    spotifyCatalogCalls: number;
    spotifyFailures: number;
    spotifyRateLimits: number;
    spotifyRetries: number;
  };
  scoreCalibration: {
    rawResolvedMin: number | null;
    rawResolvedMax: number | null;
    calibratedResolvedMin: number | null;
    calibratedResolvedMax: number | null;
  };
  nearDuplicates: {
    quarantined: number;
    rows: LikedNearDuplicateDiagnostic[];
  };
  calibratedTop: LikedCalibratedDiscoveryTopEntry[];
  mix: {
    currentSlots: number;
    exploratorySlots: number;
    exploratoryShare: number;
    capacityExploratoryShare: number;
  };
  changesVsLikedOverlay: {
    entrants: LikedCalibratedDiscoveryTopEntry[];
    exits: LikedShadowRankedRecommendation[];
  };
  readiness: {
    status: LikedDiscoveryCalibrationReadiness;
    reasons: string[];
  };
};

export async function getLikedDiscoveryCalibrationShadowReport(
  userId: string,
): Promise<LikedDiscoveryCalibrationShadowReport> {
  const expansion = await getLikedDiscoveryExpansionShadowReport(userId);
  return buildLikedDiscoveryCalibrationShadowReport(expansion);
}

export function buildLikedDiscoveryCalibrationShadowReport(
  expansion: LikedDiscoveryExpansionShadowReport,
): LikedDiscoveryCalibrationShadowReport {
  const nearDuplicates = expansion.resolvedCandidates
    .map((candidate) => ({
      candidate,
      matchedSeedNames: findNearDuplicateSeedNames(candidate),
    }))
    .filter((row) => row.matchedSeedNames.length > 0)
    .map(({ candidate, matchedSeedNames }) => ({
      artistName: candidate.artistName,
      providerArtistName: candidate.providerArtistName,
      trackName: candidate.trackName,
      spotifyTrackId: candidate.spotifyTrackId,
      rawScore: candidate.scoreCard.score,
      matchedSeedNames,
      reason: "SEED_NAME_CONTAINMENT" as const,
    }));

  const quarantinedTrackIds = new Set(nearDuplicates.map((row) => row.spotifyTrackId));
  const calibratedTop = buildLikedCalibratedDiscoveryTop({
    currentTop: expansion.likedOverlay.top,
    expansions: expansion.resolvedCandidates.filter(
      (row) => !quarantinedTrackIds.has(row.spotifyTrackId),
    ),
    topN: LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.topPerCategory,
    maxExploratorySlots:
      LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.maxExploratorySlots,
  });

  const ambiguityRate =
    expansion.resolution.attempted > 0
      ? rounded(expansion.resolution.ambiguous / expansion.resolution.attempted)
      : 0;
  const exploratorySlots = calibratedTop.filter(
    (row) => row.source === "LIKED_EXPANSION",
  ).length;
  const currentSlots = calibratedTop.length - exploratorySlots;
  const exploratoryShare =
    calibratedTop.length > 0 ? rounded(exploratorySlots / calibratedTop.length) : 0;
  const rawScores = expansion.resolvedCandidates.map((row) => row.scoreCard.score);
  const calibratedScores = expansion.resolvedCandidates.map((row) =>
    calibrateLikedExpansionScore(row.scoreCard.score),
  );
  const readinessReasons = assessReadiness({
    expansion,
    ambiguityRate,
    calibratedTop,
    nearDuplicates,
  });

  return {
    generatedAt: new Date(),
    policy: LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY,
    safety: expansion.safety,
    sourceExpansion: {
      generatedAt: new Date(expansion.generatedAt),
      baselineDiscoveryPoolSize: expansion.baseline.discoveryPoolSize,
      attempted: expansion.resolution.attempted,
      resolved: expansion.resolution.resolved,
      ambiguous: expansion.resolution.ambiguous,
      ambiguityRate,
      spotifyCatalogCalls: expansion.resolution.spotifyCatalogCalls,
      spotifyFailures: expansion.resolution.spotifyFailures,
      spotifyRateLimits: expansion.resolution.spotifyRateLimits,
      spotifyRetries: expansion.resolution.spotifyRetries,
    },
    scoreCalibration: {
      rawResolvedMin: minOrNull(rawScores),
      rawResolvedMax: maxOrNull(rawScores),
      calibratedResolvedMin: minOrNull(calibratedScores),
      calibratedResolvedMax: maxOrNull(calibratedScores),
    },
    nearDuplicates: {
      quarantined: nearDuplicates.length,
      rows: nearDuplicates,
    },
    calibratedTop,
    mix: {
      currentSlots,
      exploratorySlots,
      exploratoryShare,
      capacityExploratoryShare: rounded(
        LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.maxExploratorySlots /
          LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.topPerCategory,
      ),
    },
    changesVsLikedOverlay: {
      entrants: entrants(calibratedTop, expansion.likedOverlay.top),
      exits: exits(calibratedTop, expansion.likedOverlay.top),
    },
    readiness: {
      status:
        readinessReasons.length === 0
          ? "READY_FOR_CONTROLLED_PILOT"
          : "KEEP_SHADOW",
      reasons:
        readinessReasons.length === 0
          ? [
              "Calibrated shadow satisfies the conservative one-slot exploratory policy with clean provider health.",
            ]
          : readinessReasons,
    },
  };
}

export function buildLikedCalibratedDiscoveryTop(input: {
  currentTop: LikedShadowRankedRecommendation[];
  expansions: LikedExpansionResolvedCandidate[];
  topN: number;
  maxExploratorySlots: number;
}): LikedCalibratedDiscoveryTopEntry[] {
  if (!Number.isInteger(input.topN) || input.topN < 1) {
    throw new Error("topN must be a positive integer");
  }
  if (
    !Number.isInteger(input.maxExploratorySlots) ||
    input.maxExploratorySlots < 0 ||
    input.maxExploratorySlots > input.topN
  ) {
    throw new Error("maxExploratorySlots must be an integer between 0 and topN");
  }

  const rows: LikedCalibratedDiscoveryTopEntry[] = [
    ...input.currentTop.map((row) => ({
      source: "CURRENT_POOL" as const,
      artistName: row.artistName,
      trackName: row.trackName,
      spotifyTrackId: row.spotifyTrackId,
      signalKind: row.signalKind,
      rawScore: row.shadowRankingScore,
      calibratedScore: row.shadowRankingScore,
      explanation: row.explanation,
    })),
    ...input.expansions.map((row) => ({
      source: "LIKED_EXPANSION" as const,
      artistName: row.artistName,
      trackName: row.trackName,
      spotifyTrackId: row.spotifyTrackId,
      signalKind: "SIMILAR_EXPLORATORY",
      rawScore: row.scoreCard.score,
      calibratedScore: calibrateLikedExpansionScore(row.scoreCard.score),
      explanation: `Gate 6B calibrated LIKED exploration via ${row.seedArtistNames.slice(0, 5).join(", ")}.`,
    })),
  ].sort((left, right) => {
    if (right.calibratedScore !== left.calibratedScore) {
      return right.calibratedScore - left.calibratedScore;
    }
    if (left.source !== right.source) {
      return left.source === "CURRENT_POOL" ? -1 : 1;
    }
    return `${left.artistName}\u0000${left.trackName}`.localeCompare(
      `${right.artistName}\u0000${right.trackName}`,
    );
  });

  const selected: LikedCalibratedDiscoveryTopEntry[] = [];
  const seen = new Set<string>();
  let exploratorySlots = 0;
  for (const row of rows) {
    if (
      row.source === "LIKED_EXPANSION" &&
      exploratorySlots >= input.maxExploratorySlots
    ) {
      continue;
    }
    const key = recommendationIdentity(row);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(row);
    if (row.source === "LIKED_EXPANSION") exploratorySlots += 1;
    if (selected.length >= input.topN) break;
  }
  return selected;
}

export function calibrateLikedExpansionScore(rawScore: number): number {
  if (!Number.isFinite(rawScore)) throw new Error("rawScore must be finite");
  const floor = LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.externalScoreFloor;
  const compression =
    LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.externalScoreCompression;
  return rounded(floor + (Math.max(floor, rawScore) - floor) * compression);
}

export function findNearDuplicateSeedNames(
  candidate: LikedExpansionResolvedCandidate,
): string[] {
  return candidate.seedArtistNames
    .filter((seedName) => isNearDuplicateProjectName(candidate.artistName, seedName))
    .sort((a, b) => a.localeCompare(b));
}

export function isNearDuplicateProjectName(
  candidateArtistName: string,
  seedArtistName: string,
): boolean {
  const candidate = normalizedProjectIdentity(candidateArtistName);
  const seed = normalizedProjectIdentity(seedArtistName);
  if (!candidate || !seed || candidate === seed) return false;
  if (
    seed.split(" ").length <
    LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.nearDuplicateMinSeedTokens
  ) {
    return false;
  }
  return containsPhrase(candidate, seed) || containsPhrase(seed, candidate);
}

function assessReadiness(input: {
  expansion: LikedDiscoveryExpansionShadowReport;
  ambiguityRate: number;
  calibratedTop: LikedCalibratedDiscoveryTopEntry[];
  nearDuplicates: LikedNearDuplicateDiagnostic[];
}): string[] {
  const reasons: string[] = [];
  if (input.expansion.baseline.externalStatus !== "READY") {
    reasons.push(`Baseline external status is ${input.expansion.baseline.externalStatus}.`);
  }
  if (
    input.expansion.resolution.resolved <
    LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.minResolvedCandidatesForPilot
  ) {
    reasons.push(
      `Only ${input.expansion.resolution.resolved} candidates resolved; minimum pilot evidence is ${LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.minResolvedCandidatesForPilot}.`,
    );
  }
  if (
    input.ambiguityRate >
    LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.maxAmbiguityRateForPilot
  ) {
    reasons.push(
      `Ambiguity rate ${(input.ambiguityRate * 100).toFixed(1)}% exceeds ${(LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.maxAmbiguityRateForPilot * 100).toFixed(1)}%.`,
    );
  }
  if (input.expansion.resolution.failures.length > 0) {
    reasons.push(`${input.expansion.resolution.failures.length} provider failures occurred.`);
  }
  if (input.expansion.resolution.spotifyFailures > 0) {
    reasons.push(`${input.expansion.resolution.spotifyFailures} Spotify failures occurred.`);
  }
  if (input.expansion.resolution.spotifyRateLimits > 0) {
    reasons.push(`${input.expansion.resolution.spotifyRateLimits} Spotify rate limits occurred.`);
  }
  const exploratorySlots = input.calibratedTop.filter(
    (row) => row.source === "LIKED_EXPANSION",
  ).length;
  if (
    exploratorySlots >
    LIKED_DISCOVERY_CALIBRATION_SHADOW_POLICY.maxExploratorySlots
  ) {
    reasons.push(`Exploratory slots exceeded the configured cap: ${exploratorySlots}.`);
  }
  if (exploratorySlots === 0) {
    reasons.push("No exploratory candidate survived calibration into the top.");
  }
  const quarantinedTopIds = new Set(
    input.nearDuplicates.map((row) => row.spotifyTrackId),
  );
  if (
    input.calibratedTop.some(
      (row) => row.spotifyTrackId && quarantinedTopIds.has(row.spotifyTrackId),
    )
  ) {
    reasons.push("A quarantined near-duplicate leaked into the calibrated top.");
  }
  return reasons;
}

function normalizedProjectIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(longer: string, shorter: string): boolean {
  return (
    longer === shorter ||
    longer.startsWith(`${shorter} `) ||
    longer.endsWith(` ${shorter}`) ||
    longer.includes(` ${shorter} `)
  );
}

function entrants(
  calibrated: LikedCalibratedDiscoveryTopEntry[],
  comparison: LikedShadowRankedRecommendation[],
): LikedCalibratedDiscoveryTopEntry[] {
  const keys = new Set(comparison.map(recommendationIdentity));
  return calibrated.filter((row) => !keys.has(recommendationIdentity(row)));
}

function exits(
  calibrated: LikedCalibratedDiscoveryTopEntry[],
  comparison: LikedShadowRankedRecommendation[],
): LikedShadowRankedRecommendation[] {
  const keys = new Set(calibrated.map(recommendationIdentity));
  return comparison.filter((row) => !keys.has(recommendationIdentity(row)));
}

function recommendationIdentity(row: {
  spotifyTrackId: string | null;
  artistName: string;
  trackName: string;
}): string {
  return (
    row.spotifyTrackId ??
    `${normalizedProjectIdentity(row.artistName)}\u0000${normalizedProjectIdentity(row.trackName)}`
  );
}

function minOrNull(values: number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

function maxOrNull(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}
