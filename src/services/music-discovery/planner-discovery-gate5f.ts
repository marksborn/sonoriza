import type { Candidate } from "@/services/playlist-planner";

import type {
  DiscoveryPlannerCategory,
  DiscoveryPlannerPoolEntry,
} from "./planner-bridge";

export const DISCOVERY_GATE5F_POLICY = {
  version: "gate5f-discovery-blend-v1",
  discoveryCeiling: 0.2,
  budgetRule: "PREFIX_CEILING_NO_FORCE_FILL",
  sourceRule: "RESOLVED_SPOTIFY_ONLY",
  note:
    "Preview-only policy. DESCOBERTA may occupy at most 20% of any MUSIC pool prefix; unresolved candidates never enter and unused discovery capacity is not force-filled.",
} as const;

export type Gate5FResolvedDiscoveryCandidate = {
  candidateKey: string;
  candidate: Candidate;
  rawScore: number;
  adjustedScore: number;
  historyClass: string;
  pathLabel: string;
  resolutionReason: string;
  isrc: string | null;
};

export type Gate5FPlannerCategory = DiscoveryPlannerCategory | "DESCOBERTA";

export type Gate5FPlannerPoolEntry = {
  candidate: Candidate;
  category: Gate5FPlannerCategory;
  score: number | null;
  origin: "BASELINE" | "EXTERNAL_DISCOVERY";
  candidateKey: string | null;
  historyClass: string | null;
  pathLabel: string | null;
  resolutionReason: string | null;
  isrc: string | null;
};

export type Gate5FBlendRejectionReason =
  | "INVALID_DISCOVERY_CANDIDATE"
  | "DUPLICATE_DISCOVERY"
  | "DISCOVERY_CEILING";

export type Gate5FBlendResult = {
  music: Candidate[];
  entries: Gate5FPlannerPoolEntry[];
  rejected: Array<{
    discovery: Gate5FResolvedDiscoveryCandidate;
    reason: Gate5FBlendRejectionReason;
  }>;
  evidence: {
    policyVersion: typeof DISCOVERY_GATE5F_POLICY.version;
    inputBaselineCount: number;
    inputDiscoveryCount: number;
    acceptedDiscoveryCount: number;
    rejectedDiscoveryCount: number;
    promotedBaselineDuplicateCount: number;
    outputCount: number;
    discoveryCeiling: number;
    discoveryPositions: number[];
    maxObservedPrefixShare: number;
  };
};

export function blendResolvedDiscoveryIntoPlannerPool(input: {
  baseline: DiscoveryPlannerPoolEntry[];
  discoveries: Gate5FResolvedDiscoveryCandidate[];
  discoveryCeiling?: number;
}): Gate5FBlendResult {
  const ceiling = normalizeCeiling(
    input.discoveryCeiling ?? DISCOVERY_GATE5F_POLICY.discoveryCeiling,
  );
  const rejected: Gate5FBlendResult["rejected"] = [];
  const seenDiscoveryKeys = new Set<string>();
  const validDiscoveries: Gate5FResolvedDiscoveryCandidate[] = [];

  for (const discovery of [...input.discoveries].sort(byAdjustedScoreThenKey)) {
    if (!isUsableDiscovery(discovery)) {
      rejected.push({ discovery, reason: "INVALID_DISCOVERY_CANDIDATE" });
      continue;
    }
    const identity = candidateIdentity(discovery.candidate);
    if (seenDiscoveryKeys.has(identity)) {
      rejected.push({ discovery, reason: "DUPLICATE_DISCOVERY" });
      continue;
    }
    seenDiscoveryKeys.add(identity);
    validDiscoveries.push(discovery);
  }

  const promotedIdentities = new Set(validDiscoveries.map((row) => candidateIdentity(row.candidate)));
  const baseline = input.baseline.filter(
    (entry) => !promotedIdentities.has(candidateIdentity(entry.candidate)),
  );
  const promotedBaselineDuplicateCount = input.baseline.length - baseline.length;

  const out: Gate5FPlannerPoolEntry[] = [];
  const discoveryPositions: number[] = [];
  let baselineIndex = 0;
  let discoveryIndex = 0;
  let discoverySelected = 0;
  let maxObservedPrefixShare = 0;

  while (baselineIndex < baseline.length || discoveryIndex < validDiscoveries.length) {
    const nextPosition = out.length + 1;
    const mayTakeDiscovery =
      discoveryIndex < validDiscoveries.length &&
      (discoverySelected + 1) / nextPosition <= ceiling + Number.EPSILON;

    if (mayTakeDiscovery) {
      const discovery = validDiscoveries[discoveryIndex++]!;
      out.push(discoveryEntry(discovery));
      discoverySelected += 1;
      discoveryPositions.push(nextPosition);
      maxObservedPrefixShare = Math.max(
        maxObservedPrefixShare,
        discoverySelected / nextPosition,
      );
      continue;
    }

    if (baselineIndex < baseline.length) {
      out.push(baselineEntry(baseline[baselineIndex++]!));
      if (discoverySelected > 0) {
        maxObservedPrefixShare = Math.max(
          maxObservedPrefixShare,
          discoverySelected / nextPosition,
        );
      }
      continue;
    }

    // Ceiling is a hard safety bound, not a quota. When the baseline pool is
    // exhausted we abstain instead of relaxing the ceiling merely to include
    // every resolved discovery.
    for (; discoveryIndex < validDiscoveries.length; discoveryIndex += 1) {
      rejected.push({
        discovery: validDiscoveries[discoveryIndex]!,
        reason: "DISCOVERY_CEILING",
      });
    }
    break;
  }

  return {
    music: out.map((entry) => entry.candidate),
    entries: out,
    rejected,
    evidence: {
      policyVersion: DISCOVERY_GATE5F_POLICY.version,
      inputBaselineCount: input.baseline.length,
      inputDiscoveryCount: input.discoveries.length,
      acceptedDiscoveryCount: discoverySelected,
      rejectedDiscoveryCount: rejected.length,
      promotedBaselineDuplicateCount,
      outputCount: out.length,
      discoveryCeiling: ceiling,
      discoveryPositions,
      maxObservedPrefixShare,
    },
  };
}

function baselineEntry(entry: DiscoveryPlannerPoolEntry): Gate5FPlannerPoolEntry {
  return {
    candidate: entry.candidate,
    category: entry.category,
    score: entry.score,
    origin: "BASELINE",
    candidateKey: null,
    historyClass: null,
    pathLabel: null,
    resolutionReason: null,
    isrc: null,
  };
}

function discoveryEntry(
  discovery: Gate5FResolvedDiscoveryCandidate,
): Gate5FPlannerPoolEntry {
  return {
    candidate: discovery.candidate,
    category: "DESCOBERTA",
    score: discovery.adjustedScore,
    origin: "EXTERNAL_DISCOVERY",
    candidateKey: discovery.candidateKey,
    historyClass: discovery.historyClass,
    pathLabel: discovery.pathLabel,
    resolutionReason: discovery.resolutionReason,
    isrc: discovery.isrc,
  };
}

function isUsableDiscovery(discovery: Gate5FResolvedDiscoveryCandidate): boolean {
  const candidate = discovery.candidate;
  return Boolean(
    candidate.type === "MUSIC" &&
      candidate.uri.trim() &&
      candidate.spotifyTrackId?.trim() &&
      candidate.primaryArtistId?.trim() &&
      candidate.durationMs > 0 &&
      Number.isFinite(discovery.adjustedScore),
  );
}

function candidateIdentity(candidate: Candidate): string {
  const trackId = candidate.spotifyTrackId?.trim();
  return trackId ? `track:${trackId}` : `uri:${candidate.uri}`;
}

function byAdjustedScoreThenKey(
  a: Gate5FResolvedDiscoveryCandidate,
  b: Gate5FResolvedDiscoveryCandidate,
): number {
  return b.adjustedScore - a.adjustedScore || a.candidateKey.localeCompare(b.candidateKey);
}

function normalizeCeiling(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("DISCOVERY Gate 5F discoveryCeiling must be between 0 and 1");
  }
  return value;
}
