import type { Candidate } from "@/services/playlist-planner";

import {
  blendResolvedDiscoveryIntoPlannerPool,
  type Gate5FBlendResult,
  type Gate5FResolvedDiscoveryCandidate,
} from "./planner-discovery-gate5f";
import {
  DISCOVERY_PLANNER_PREVIEW_POLICY_V1,
  type DiscoveryPlannerPoolEntry,
} from "./planner-bridge";
import {
  allowedTargetDiscoveryFamilies,
  discoveryIntensityRank,
  normalizeTargetDiscoveryPolicy,
  type PersistedTargetDiscoveryPolicy,
  type TargetDiscoveryFamily,
  type TargetDiscoveryPolicy,
} from "./target-discovery-policy";

export const TARGET_DISCOVERY_PLANNER_GATE4_POLICY = {
  version: "discover-dest-gate4-shadow-v1",
  mode: "SHADOW_PREVIEW",
  sourceRule: "NORMAL_SOURCE_CANDIDATES_ARE_NEVER_REMOVED_BY_FAMILY_TOGGLES",
  disabledSourceFamilyRule: "DEMOTE_TO_SOURCE_FALLBACK",
  externalDiscoveryRule: "ADMIT_ONLY_WHEN_DISCOVERY_FAMILY_ENABLED",
  releaseProviderRule: "ABSTAIN_WHEN_PROVIDER_UNAVAILABLE",
  intensityRule: "ORDINAL_CALIBRATION_SIGNAL_NOT_QUOTA",
  albums: "EXCLUDED",
} as const;

export type TargetDiscoveryPlannerProjection = {
  targetPlaylistId: string;
  policy: TargetDiscoveryPolicy;
  configuredFamilies: TargetDiscoveryFamily[];
  effectiveFamilies: TargetDiscoveryFamily[];
  sourceEntries: DiscoveryPlannerPoolEntry[];
  externalDiscoveries: Gate5FResolvedDiscoveryCandidate[];
  blend: Gate5FBlendResult;
  evidence: {
    policyVersion: typeof TARGET_DISCOVERY_PLANNER_GATE4_POLICY.version;
    mode: typeof TARGET_DISCOVERY_PLANNER_GATE4_POLICY.mode;
    targetPlaylistId: string;
    policyEnabled: boolean;
    intensity: TargetDiscoveryPolicy["intensity"];
    intensityRank: 1 | 2 | 3;
    configuredFamilies: TargetDiscoveryFamily[];
    effectiveFamilies: TargetDiscoveryFamily[];
    inputSourceCount: number;
    outputSourceCount: number;
    sourceCandidateCountPreserved: number;
    familiarPromotedCount: number;
    rediscoveryPromotedCount: number;
    sourceFallbackCount: number;
    demotedByPolicyCount: number;
    inputExternalDiscoveryCount: number;
    admittedExternalDiscoveryCount: number;
    suppressedExternalDiscoveryCount: number;
    releaseProviderAvailable: false;
    releaseRequestedButUnavailable: boolean;
    albumCandidatesAccepted: 0;
    rediscoveryCeiling: number;
    externalDiscoveryCeiling: number;
    forcedFill: false;
  };
};

export function projectTargetDiscoveryPlannerInput(input: {
  targetPlaylistId: string;
  persistedPolicy: PersistedTargetDiscoveryPolicy | null | undefined;
  sourceEntries: DiscoveryPlannerPoolEntry[];
  externalDiscoveries?: Gate5FResolvedDiscoveryCandidate[];
  rediscoveryCeiling?: number;
  externalDiscoveryCeiling?: number;
}): TargetDiscoveryPlannerProjection {
  const policy = normalizeTargetDiscoveryPolicy(input.persistedPolicy);
  const configuredFamilies = allowedTargetDiscoveryFamilies(policy);
  const effectiveFamilies = configuredFamilies.filter(
    (family) => family !== "RELEASE",
  );
  const rediscoveryCeiling = normalizeCeiling(
    input.rediscoveryCeiling ??
      DISCOVERY_PLANNER_PREVIEW_POLICY_V1.rediscoveryCeiling,
    "rediscoveryCeiling",
  );
  const sourceProjection = projectSourceEntries(
    input.sourceEntries,
    policy,
    rediscoveryCeiling,
  );
  const externalInput = input.externalDiscoveries ?? [];
  const externalDiscoveries =
    policy.enabled && policy.discoveryEnabled ? externalInput : [];
  const blend = blendResolvedDiscoveryIntoPlannerPool({
    baseline: sourceProjection.entries,
    discoveries: externalDiscoveries,
    ...(input.externalDiscoveryCeiling == null
      ? {}
      : { discoveryCeiling: input.externalDiscoveryCeiling }),
  });

  return {
    targetPlaylistId: input.targetPlaylistId,
    policy,
    configuredFamilies,
    effectiveFamilies,
    sourceEntries: sourceProjection.entries,
    externalDiscoveries,
    blend,
    evidence: {
      policyVersion: TARGET_DISCOVERY_PLANNER_GATE4_POLICY.version,
      mode: TARGET_DISCOVERY_PLANNER_GATE4_POLICY.mode,
      targetPlaylistId: input.targetPlaylistId,
      policyEnabled: policy.enabled,
      intensity: policy.intensity,
      intensityRank: discoveryIntensityRank(policy.intensity),
      configuredFamilies,
      effectiveFamilies,
      inputSourceCount: input.sourceEntries.length,
      outputSourceCount: sourceProjection.entries.length,
      sourceCandidateCountPreserved: sourceProjection.entries.length,
      familiarPromotedCount: sourceProjection.entries.filter(
        (entry) => entry.category === "FAMILIAR",
      ).length,
      rediscoveryPromotedCount: sourceProjection.entries.filter(
        (entry) => entry.category === "REDESCOBERTA",
      ).length,
      sourceFallbackCount: sourceProjection.entries.filter(
        (entry) => entry.category === "SOURCE_FALLBACK",
      ).length,
      demotedByPolicyCount: sourceProjection.demotedByPolicyCount,
      inputExternalDiscoveryCount: externalInput.length,
      admittedExternalDiscoveryCount: blend.evidence.acceptedDiscoveryCount,
      suppressedExternalDiscoveryCount:
        externalInput.length - blend.evidence.acceptedDiscoveryCount,
      releaseProviderAvailable: false,
      releaseRequestedButUnavailable:
        policy.enabled && policy.releasesEnabled,
      albumCandidatesAccepted: 0,
      rediscoveryCeiling,
      externalDiscoveryCeiling: blend.evidence.discoveryCeiling,
      forcedFill: false,
    },
  };
}

function projectSourceEntries(
  entries: DiscoveryPlannerPoolEntry[],
  policy: TargetDiscoveryPolicy,
  rediscoveryCeiling: number,
): { entries: DiscoveryPlannerPoolEntry[]; demotedByPolicyCount: number } {
  let demotedByPolicyCount = 0;
  const rediscovery: DiscoveryPlannerPoolEntry[] = [];
  const familiar: DiscoveryPlannerPoolEntry[] = [];
  const sourceFallback: DiscoveryPlannerPoolEntry[] = [];

  for (const entry of entries) {
    if (
      policy.enabled &&
      entry.category === "REDESCOBERTA" &&
      policy.rediscoveryEnabled
    ) {
      rediscovery.push(entry);
      continue;
    }
    if (
      policy.enabled &&
      entry.category === "FAMILIAR" &&
      policy.familiarEnabled
    ) {
      familiar.push(entry);
      continue;
    }

    if (entry.category !== "SOURCE_FALLBACK") demotedByPolicyCount += 1;
    sourceFallback.push(demoteToSourceFallback(entry));
  }

  rediscovery.sort(byScoreThenSourceOrder);
  familiar.sort(byScoreThenSourceOrder);
  sourceFallback.sort(bySourceOrder);

  return {
    entries: interleaveRediscovery(
      rediscovery,
      [...familiar, ...sourceFallback],
      rediscoveryCeiling,
    ),
    demotedByPolicyCount,
  };
}

function demoteToSourceFallback(
  entry: DiscoveryPlannerPoolEntry,
): DiscoveryPlannerPoolEntry {
  return {
    ...entry,
    category: "SOURCE_FALLBACK",
    score: null,
    matchSource: "NONE",
    matchedScoreTrackId: null,
  };
}

function interleaveRediscovery(
  rediscovery: DiscoveryPlannerPoolEntry[],
  nonRediscovery: DiscoveryPlannerPoolEntry[],
  ceiling: number,
): DiscoveryPlannerPoolEntry[] {
  const out: DiscoveryPlannerPoolEntry[] = [];
  let rediscoveryIndex = 0;
  let nonRediscoveryIndex = 0;
  let rediscoverySelected = 0;

  while (
    rediscoveryIndex < rediscovery.length ||
    nonRediscoveryIndex < nonRediscovery.length
  ) {
    const nextPosition = out.length + 1;
    const mayTakeRediscovery =
      rediscoveryIndex < rediscovery.length &&
      (rediscoverySelected + 1) / nextPosition <= ceiling + Number.EPSILON;

    if (mayTakeRediscovery) {
      out.push(rediscovery[rediscoveryIndex++]!);
      rediscoverySelected += 1;
      continue;
    }

    if (nonRediscoveryIndex < nonRediscovery.length) {
      out.push(nonRediscovery[nonRediscoveryIndex++]!);
      continue;
    }

    // These are still normal source candidates. Once alternatives are exhausted,
    // retaining them is source preservation rather than forced discovery fill.
    out.push(rediscovery[rediscoveryIndex++]!);
    rediscoverySelected += 1;
  }

  return out;
}

function byScoreThenSourceOrder(
  left: DiscoveryPlannerPoolEntry,
  right: DiscoveryPlannerPoolEntry,
): number {
  return (right.score ?? -1) - (left.score ?? -1) || bySourceOrder(left, right);
}

function bySourceOrder(
  left: DiscoveryPlannerPoolEntry,
  right: DiscoveryPlannerPoolEntry,
): number {
  return left.originalIndex - right.originalIndex;
}

export function targetDiscoveryCandidateIds(
  projection: TargetDiscoveryPlannerProjection,
): string[] {
  return projection.blend.music.map(candidateId);
}

function candidateId(candidate: Candidate): string {
  return candidate.spotifyTrackId?.trim() || candidate.uri;
}

function normalizeCeiling(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}
