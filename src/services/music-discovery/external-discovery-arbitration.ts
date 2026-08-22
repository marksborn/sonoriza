import type { EvaluatedExternalDiscoveryCandidate } from "./external-discovery";

export type ExternalDiscoveryPathCandidate = EvaluatedExternalDiscoveryCandidate & {
  acquisitionDepth: 1 | 2;
  rootSeedArtistName: string;
  viaArtistName: string | null;
};

export type ExternalDiscoveryPathArbitrationRejectionReason =
  | "PATH_CAP"
  | "ROOT_CAP"
  | "BRIDGE_CAP"
  | "ADJUSTED_SCORE_BELOW_MINIMUM"
  | "TOP_N";

export type ExternalDiscoveryPathArbitratedCandidate = ExternalDiscoveryPathCandidate & {
  pathKey: string;
  pathLabel: string;
  pathSelectionIndex: number;
  arbitrationAdjustedScore: number;
};

export type ExternalDiscoveryPathArbitrationRejection = {
  candidate: ExternalDiscoveryPathCandidate;
  reason: ExternalDiscoveryPathArbitrationRejectionReason;
  pathKey: string;
  pathLabel: string;
  pathSelectionIndex: number;
  arbitrationAdjustedScore: number;
};

export type ExternalDiscoveryPathArbitrationResult = {
  selected: ExternalDiscoveryPathArbitratedCandidate[];
  rejected: ExternalDiscoveryPathArbitrationRejection[];
  policy: {
    topN: number;
    maxPerPath: number;
    maxPerRoot: number;
    maxPerBridge: number;
    repeatPenaltyPerSelection: number;
    minimumAdjustedScore: number;
  };
};

export type ExternalDiscoveryConcentrationEntry = {
  key: string;
  label: string;
  count: number;
  share: number;
};

export type ExternalDiscoveryPathConcentration = {
  total: number;
  uniqueRoots: number;
  uniqueBridges: number;
  uniquePaths: number;
  roots: ExternalDiscoveryConcentrationEntry[];
  bridges: ExternalDiscoveryConcentrationEntry[];
  paths: ExternalDiscoveryConcentrationEntry[];
  maxRootShare: number;
  maxBridgeShare: number;
  maxPathShare: number;
};

export function arbitrateExternalDiscoveryPaths(input: {
  candidates: ExternalDiscoveryPathCandidate[];
  topN?: number;
  maxPerPath?: number;
  maxPerRoot?: number;
  maxPerBridge?: number;
  repeatPenaltyPerSelection?: number;
  minimumAdjustedScore?: number;
}): ExternalDiscoveryPathArbitrationResult {
  const topN = boundedPositiveInt(input.topN ?? 30, "topN", 500);
  const maxPerPath = boundedPositiveInt(input.maxPerPath ?? 2, "maxPerPath", 100);
  const maxPerRoot = boundedPositiveInt(input.maxPerRoot ?? 3, "maxPerRoot", 100);
  const maxPerBridge = boundedPositiveInt(input.maxPerBridge ?? 2, "maxPerBridge", 100);
  const repeatPenaltyPerSelection = boundedUnit(
    input.repeatPenaltyPerSelection ?? 0.07,
    "repeatPenaltyPerSelection",
  );
  const minimumAdjustedScore = boundedScore(
    input.minimumAdjustedScore ?? 55,
    "minimumAdjustedScore",
  );

  const eligible = input.candidates
    .filter((candidate) => candidate.scoreCard.eligible)
    .sort((left, right) => {
      const scoreDelta = right.scoreCard.score - left.scoreCard.score;
      if (scoreDelta !== 0) return scoreDelta;
      const similarityDelta = right.similarity - left.similarity;
      if (similarityDelta !== 0) return similarityDelta;
      return left.candidateKey.localeCompare(right.candidateKey);
    });

  const pathCounts = new Map<string, number>();
  const rootCounts = new Map<string, number>();
  const bridgeCounts = new Map<string, number>();
  const selected: ExternalDiscoveryPathArbitratedCandidate[] = [];
  const rejected: ExternalDiscoveryPathArbitrationRejection[] = [];

  for (const candidate of eligible) {
    const rootKey = normalized(candidate.rootSeedArtistName);
    const bridgeKey = candidate.viaArtistName ? normalized(candidate.viaArtistName) : null;
    const path = pathIdentity(candidate);
    const pathCount = pathCounts.get(path.key) ?? 0;
    const rootCount = rootCounts.get(rootKey) ?? 0;
    const bridgeCount = bridgeKey ? bridgeCounts.get(bridgeKey) ?? 0 : 0;
    const pathSelectionIndex = pathCount + 1;
    const arbitrationAdjustedScore = roundScore(
      candidate.scoreCard.score *
        Math.max(0, 1 - repeatPenaltyPerSelection * Math.max(0, pathSelectionIndex - 1)),
    );

    let reason: ExternalDiscoveryPathArbitrationRejectionReason | null = null;
    if (selected.length >= topN) reason = "TOP_N";
    else if (pathCount >= maxPerPath) reason = "PATH_CAP";
    else if (rootCount >= maxPerRoot) reason = "ROOT_CAP";
    else if (bridgeKey && bridgeCount >= maxPerBridge) reason = "BRIDGE_CAP";
    else if (arbitrationAdjustedScore < minimumAdjustedScore) {
      reason = "ADJUSTED_SCORE_BELOW_MINIMUM";
    }

    if (reason) {
      rejected.push({
        candidate,
        reason,
        pathKey: path.key,
        pathLabel: path.label,
        pathSelectionIndex,
        arbitrationAdjustedScore,
      });
      continue;
    }

    selected.push({
      ...candidate,
      pathKey: path.key,
      pathLabel: path.label,
      pathSelectionIndex,
      arbitrationAdjustedScore,
    });
    pathCounts.set(path.key, pathCount + 1);
    rootCounts.set(rootKey, rootCount + 1);
    if (bridgeKey) bridgeCounts.set(bridgeKey, bridgeCount + 1);
  }

  return {
    selected,
    rejected,
    policy: {
      topN,
      maxPerPath,
      maxPerRoot,
      maxPerBridge,
      repeatPenaltyPerSelection,
      minimumAdjustedScore,
    },
  };
}

export function summarizeExternalDiscoveryPathConcentration(
  candidates: ExternalDiscoveryPathCandidate[],
): ExternalDiscoveryPathConcentration {
  const total = candidates.length;
  const rootCounts = new Map<string, { label: string; count: number }>();
  const bridgeCounts = new Map<string, { label: string; count: number }>();
  const pathCounts = new Map<string, { label: string; count: number }>();

  for (const candidate of candidates) {
    const rootKey = normalized(candidate.rootSeedArtistName);
    increment(rootCounts, rootKey, candidate.rootSeedArtistName);

    if (candidate.viaArtistName) {
      const bridgeKey = normalized(candidate.viaArtistName);
      increment(bridgeCounts, bridgeKey, candidate.viaArtistName);
    }

    const path = pathIdentity(candidate);
    increment(pathCounts, path.key, path.label);
  }

  const roots = concentrationEntries(rootCounts, total);
  const bridges = concentrationEntries(bridgeCounts, total);
  const paths = concentrationEntries(pathCounts, total);

  return {
    total,
    uniqueRoots: roots.length,
    uniqueBridges: bridges.length,
    uniquePaths: paths.length,
    roots,
    bridges,
    paths,
    maxRootShare: roots[0]?.share ?? 0,
    maxBridgeShare: bridges[0]?.share ?? 0,
    maxPathShare: paths[0]?.share ?? 0,
  };
}

function pathIdentity(candidate: ExternalDiscoveryPathCandidate): { key: string; label: string } {
  const root = candidate.rootSeedArtistName.trim();
  if (candidate.acquisitionDepth === 1 || !candidate.viaArtistName) {
    return {
      key: `${normalized(root)}>direct`,
      label: `${root} → direct`,
    };
  }

  const bridge = candidate.viaArtistName.trim();
  return {
    key: `${normalized(root)}>${normalized(bridge)}`,
    label: `${root} → ${bridge}`,
  };
}

function increment(
  rows: Map<string, { label: string; count: number }>,
  key: string,
  label: string,
): void {
  const current = rows.get(key);
  if (current) {
    current.count += 1;
    return;
  }
  rows.set(key, { label, count: 1 });
}

function concentrationEntries(
  rows: Map<string, { label: string; count: number }>,
  total: number,
): ExternalDiscoveryConcentrationEntry[] {
  return [...rows.entries()]
    .map(([key, row]) => ({
      key,
      label: row.label,
      count: row.count,
      share: total === 0 ? 0 : Number((row.count / total).toFixed(4)),
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function boundedPositiveInt(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function boundedUnit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

function boundedScore(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be between 0 and 100`);
  }
  return value;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}
