import type { Podcast06ListeningStateEvidence } from "@/services/playlist-planner/podcast-cadence-shadow-runtime";

import type { PodcastEffectivePolicyShadowResult } from "./podcast-effective-policy-shadow";
import type { Podcast07PoolShadowCandidate } from "./podcast-efficient-pool-shadow";
import {
  evaluatePodcastShowCadenceShadow,
  type PodcastCadenceWindow,
} from "./podcast-show-cadence-shadow";

const GLOBAL_POOL_SYNTHETIC_SHOW_ID = "podcast07:global-pool";

export type Podcast07GlobalPoolShadowStatus =
  | "NO_POLICY"
  | "NOT_GLOBAL_POOL"
  | "ABSTAIN_TIMEZONE_UNAVAILABLE"
  | "ABSTAIN_INCOMPLETE_CANDIDATE_PROVENANCE"
  | "ABSTAIN_INCONSISTENT_CANDIDATE_PROVENANCE"
  | "ABSTAIN_INCOMPLETE_FACTUAL_PROVENANCE"
  | "READY_SHADOW";

export type Podcast07GlobalPoolExcludedFactualConsumption = Readonly<{
  spotifyEpisodeId: string;
  spotifyShowId: string;
  firstProgressObservedAt: string;
  reason:
    | "SHOW_OVERRIDE"
    | "LEGACY_SAVED_EPISODES"
    | "NOT_IN_CURRENT_SAVED_POOL";
}>;

export type Podcast07GlobalPoolCadenceShadowResult = Readonly<{
  policyVersion: "podcast07-gate5-global-pool-shadow-v1";
  status: Podcast07GlobalPoolShadowStatus;
  plannerInfluence: false;
  databaseWrites: false;
  spotifyWrites: false;
  governanceSemantics: "CURRENT_EFFECTIVE_AUTHORITY_AT_EVALUATION";
  governanceSnapshotAt: string;
  defaultPolicyEnabled: boolean;
  frequencyScope: "PER_SHOW" | "GLOBAL_POOL" | null;
  cadenceConfigured: boolean;
  cadenceMaxEpisodes: number | null;
  cadenceUnit: "WEEK" | null;
  timeZone: string | null;
  window: PodcastCadenceWindow | null;
  governedShowIds: readonly string[];
  overrideExcludedShowIds: readonly string[];
  governedCandidateCount: number;
  factualListeningStateCount: number;
  resolvedFactualListeningStateCount: number;
  unresolvedFactualListeningStateCount: number;
  governedFactualListeningStateCount: number;
  excludedFactualListeningStateCount: number;
  excludedFactualConsumption: readonly Podcast07GlobalPoolExcludedFactualConsumption[];
  candidateMissingEpisodeIdentityCount: number;
  candidateMissingShowIdentityCount: number;
  candidateGovernanceMismatchCount: number;
  candidateShowConflictEpisodeIds: readonly string[];
  consumedEpisodeIds: readonly string[];
  consumedCount: number | null;
  limitReached: boolean | null;
  newEpisodeAllowedByCadence: boolean | null;
  inProgressContinuationEpisodeIds: readonly string[];
  projectedBlockedEpisodeIds: readonly string[];
  legacyConsumptionWithoutTimestampEpisodeIds: readonly string[];
  diagnosticCodes: readonly string[];
}>;

/**
 * PODCAST-07 Gate 5 GLOBAL_POOL cadence projection.
 *
 * Governance rule for V1 is intentionally explicit and stateless:
 * CURRENT_EFFECTIVE_AUTHORITY_AT_EVALUATION. Every evaluation derives the
 * governed show set from the current effective-policy snapshot. A SHOW override
 * takes effect immediately, including for factual listens earlier in the same
 * civil week: those listens are excluded from the shared default budget on the
 * next evaluation. Removing the override does the inverse. This avoids
 * inventing historical source attribution from titles, GenerationItems or
 * publication records and keeps the shadow projection reproducible from its
 * inputs. The excluded factual rows are returned as audit evidence.
 *
 * The cadence window and factual/idempotent counting semantics are delegated to
 * the PODCAST-06 evaluator by remapping only currently default-governed shows to
 * one synthetic pool identity. This module remains shadow-only; Gate 7 owns any
 * productive planner influence.
 */
export function projectPodcast07GlobalPoolCadenceShadow(input: {
  policyResolution: PodcastEffectivePolicyShadowResult;
  candidates: readonly Podcast07PoolShadowCandidate[];
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  timeZone: string | null;
  asOf: Date;
}): Podcast07GlobalPoolCadenceShadowResult {
  const defaultPolicy = input.policyResolution.defaultPolicy;
  const cadenceMaxEpisodes = defaultPolicy?.cadenceMaxEpisodes ?? null;
  const cadenceUnit = defaultPolicy?.cadenceUnit ?? null;
  const cadenceConfigured = cadenceMaxEpisodes !== null && cadenceUnit !== null;
  const defaultPolicyEnabled = defaultPolicy?.enabled === true;
  const frequencyScope = defaultPolicy?.frequencyScope ?? null;
  const globalPoolEnabled =
    defaultPolicyEnabled && frequencyScope === "GLOBAL_POOL" && cadenceConfigured;

  const authorityByShowId = new Map(
    input.policyResolution.groups.map((group) => [
      group.spotifyShowId,
      group.effectivePolicy.authority,
    ] as const),
  );
  const governedShowIds = input.policyResolution.groups
    .filter(
      (group) => group.effectivePolicy.authority === "SAVED_EPISODES_DEFAULT",
    )
    .map((group) => group.spotifyShowId)
    .sort();
  const governedShows = new Set(governedShowIds);
  const overrideExcludedShowIds = input.policyResolution.groups
    .filter((group) => group.effectivePolicy.authority === "SHOW_OVERRIDE")
    .map((group) => group.spotifyShowId)
    .sort();

  const candidateProvenance = candidateEpisodeShowMap(input.candidates);
  let candidateMissingEpisodeIdentityCount = 0;
  let candidateMissingShowIdentityCount = 0;
  let candidateGovernanceMismatchCount = 0;
  const governedCandidates: Array<{
    spotifyEpisodeId: string;
    spotifyShowId: string;
    status: Podcast06ListeningStateEvidence["status"];
  }> = [];
  const candidateStates = candidateListeningStateMap(input.listeningStates);

  for (const candidate of input.candidates) {
    if (candidate.authority !== "SAVED_EPISODES_DEFAULT") continue;
    const spotifyEpisodeId = normalizedId(candidate.spotifyEpisodeId);
    const spotifyShowId = normalizedId(candidate.spotifyShowId);
    if (!spotifyEpisodeId) {
      candidateMissingEpisodeIdentityCount += 1;
      continue;
    }
    if (!spotifyShowId) {
      candidateMissingShowIdentityCount += 1;
      continue;
    }
    if (!governedShows.has(spotifyShowId)) {
      candidateGovernanceMismatchCount += 1;
      continue;
    }
    governedCandidates.push({
      spotifyEpisodeId,
      spotifyShowId,
      status: candidateStates.get(spotifyEpisodeId)?.status ?? "NOT_STARTED",
    });
  }

  const factualStates = input.listeningStates.filter(
    (state) => state.firstProgressObservedAt !== null,
  );
  let resolvedFactualListeningStateCount = 0;
  let unresolvedFactualListeningStateCount = 0;
  let governedFactualListeningStateCount = 0;
  const excludedFactualConsumption: Podcast07GlobalPoolExcludedFactualConsumption[] = [];
  const syntheticEvidence: Podcast06ListeningStateEvidence[] = [];

  for (const state of input.listeningStates) {
    const resolvedShowId =
      normalizedId(state.spotifyShowId) ??
      candidateProvenance.episodeToShow.get(state.spotifyEpisodeId) ??
      null;
    const factual = state.firstProgressObservedAt !== null;

    if (factual) {
      if (resolvedShowId) resolvedFactualListeningStateCount += 1;
      else unresolvedFactualListeningStateCount += 1;
    }

    if (!resolvedShowId || !governedShows.has(resolvedShowId)) {
      if (factual && resolvedShowId && state.firstProgressObservedAt) {
        excludedFactualConsumption.push({
          spotifyEpisodeId: state.spotifyEpisodeId,
          spotifyShowId: resolvedShowId,
          firstProgressObservedAt: state.firstProgressObservedAt.toISOString(),
          reason: excludedReason(authorityByShowId.get(resolvedShowId)),
        });
      }
      continue;
    }

    if (factual) governedFactualListeningStateCount += 1;
    syntheticEvidence.push({
      ...state,
      spotifyShowId: GLOBAL_POOL_SYNTHETIC_SHOW_ID,
    });
  }

  const timeZone = normalizedId(input.timeZone);
  let status: Podcast07GlobalPoolShadowStatus;
  if (!defaultPolicyEnabled || !cadenceConfigured) {
    status = "NO_POLICY";
  } else if (frequencyScope !== "GLOBAL_POOL") {
    status = "NOT_GLOBAL_POOL";
  } else if (!timeZone) {
    status = "ABSTAIN_TIMEZONE_UNAVAILABLE";
  } else if (candidateProvenance.conflictingEpisodeIds.length > 0) {
    status = "ABSTAIN_INCONSISTENT_CANDIDATE_PROVENANCE";
  } else if (
    candidateMissingEpisodeIdentityCount > 0 ||
    candidateMissingShowIdentityCount > 0 ||
    candidateGovernanceMismatchCount > 0
  ) {
    status = "ABSTAIN_INCOMPLETE_CANDIDATE_PROVENANCE";
  } else if (unresolvedFactualListeningStateCount > 0) {
    status = "ABSTAIN_INCOMPLETE_FACTUAL_PROVENANCE";
  } else {
    status = "READY_SHADOW";
  }

  let window: PodcastCadenceWindow | null = null;
  let consumedEpisodeIds: string[] = [];
  let consumedCount: number | null = null;
  let limitReached: boolean | null = null;
  let newEpisodeAllowedByCadence: boolean | null = null;
  let legacyConsumptionWithoutTimestampEpisodeIds: string[] = [];
  let inProgressContinuationEpisodeIds: string[] = [];
  let projectedBlockedEpisodeIds: string[] = [];

  if (
    globalPoolEnabled &&
    status === "READY_SHADOW" &&
    timeZone &&
    cadenceMaxEpisodes !== null &&
    cadenceUnit !== null
  ) {
    const evaluation = evaluatePodcastShowCadenceShadow({
      evidence: syntheticEvidence,
      showId: GLOBAL_POOL_SYNTHETIC_SHOW_ID,
      maxEpisodes: cadenceMaxEpisodes,
      unit: cadenceUnit,
      timeZone,
      asOf: input.asOf,
    });
    window = evaluation.window;
    consumedEpisodeIds = evaluation.consumedEpisodeIds;
    consumedCount = evaluation.consumedCount;
    limitReached = evaluation.limitReached;
    newEpisodeAllowedByCadence = evaluation.newEpisodeAllowedByCadence;
    legacyConsumptionWithoutTimestampEpisodeIds =
      evaluation.legacyConsumptionWithoutTimestampEpisodeIds;

    inProgressContinuationEpisodeIds = governedCandidates
      .filter((candidate) => candidate.status === "IN_PROGRESS")
      .map((candidate) => candidate.spotifyEpisodeId)
      .sort();

    if (evaluation.limitReached) {
      projectedBlockedEpisodeIds = governedCandidates
        .filter((candidate) => candidate.status !== "IN_PROGRESS")
        .map((candidate) => candidate.spotifyEpisodeId)
        .sort();
    }
  }

  const diagnosticCodes = ["GLOBAL_POOL_CURRENT_AUTHORITY_AT_EVALUATION"];
  if (excludedFactualConsumption.some((entry) => entry.reason === "SHOW_OVERRIDE")) {
    diagnosticCodes.push("GLOBAL_POOL_OVERRIDE_FACTUAL_CONSUMPTION_EXCLUDED");
  }
  if (
    excludedFactualConsumption.some(
      (entry) => entry.reason === "NOT_IN_CURRENT_SAVED_POOL",
    )
  ) {
    diagnosticCodes.push("GLOBAL_POOL_NON_GOVERNED_FACTUAL_CONSUMPTION_EXCLUDED");
  }
  if (limitReached === true) diagnosticCodes.push("GLOBAL_POOL_CADENCE_LIMIT_REACHED");
  if (inProgressContinuationEpisodeIds.length > 0) {
    diagnosticCodes.push("GLOBAL_POOL_IN_PROGRESS_CONTINUATION");
  }

  return {
    policyVersion: "podcast07-gate5-global-pool-shadow-v1",
    status,
    plannerInfluence: false,
    databaseWrites: false,
    spotifyWrites: false,
    governanceSemantics: "CURRENT_EFFECTIVE_AUTHORITY_AT_EVALUATION",
    governanceSnapshotAt: input.asOf.toISOString(),
    defaultPolicyEnabled,
    frequencyScope,
    cadenceConfigured,
    cadenceMaxEpisodes,
    cadenceUnit,
    timeZone,
    window,
    governedShowIds,
    overrideExcludedShowIds,
    governedCandidateCount: governedCandidates.length,
    factualListeningStateCount: factualStates.length,
    resolvedFactualListeningStateCount,
    unresolvedFactualListeningStateCount,
    governedFactualListeningStateCount,
    excludedFactualListeningStateCount: excludedFactualConsumption.length,
    excludedFactualConsumption: excludedFactualConsumption.sort((left, right) =>
      left.spotifyEpisodeId.localeCompare(right.spotifyEpisodeId),
    ),
    candidateMissingEpisodeIdentityCount,
    candidateMissingShowIdentityCount,
    candidateGovernanceMismatchCount,
    candidateShowConflictEpisodeIds: candidateProvenance.conflictingEpisodeIds,
    consumedEpisodeIds,
    consumedCount,
    limitReached,
    newEpisodeAllowedByCadence,
    inProgressContinuationEpisodeIds,
    projectedBlockedEpisodeIds,
    legacyConsumptionWithoutTimestampEpisodeIds,
    diagnosticCodes,
  };
}

function candidateEpisodeShowMap(
  candidates: readonly Podcast07PoolShadowCandidate[],
): {
  episodeToShow: ReadonlyMap<string, string>;
  conflictingEpisodeIds: string[];
} {
  const episodeToShow = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const candidate of candidates) {
    const episodeId = normalizedId(candidate.spotifyEpisodeId);
    const showId = normalizedId(candidate.spotifyShowId);
    if (!episodeId || !showId) continue;
    const existing = episodeToShow.get(episodeId);
    if (existing && existing !== showId) {
      conflicts.add(episodeId);
      continue;
    }
    episodeToShow.set(episodeId, showId);
  }
  return {
    episodeToShow,
    conflictingEpisodeIds: [...conflicts].sort(),
  };
}

function candidateListeningStateMap(
  listeningStates: readonly Podcast06ListeningStateEvidence[],
): ReadonlyMap<string, Podcast06ListeningStateEvidence> {
  const result = new Map<string, Podcast06ListeningStateEvidence>();
  for (const state of listeningStates) {
    const existing = result.get(state.spotifyEpisodeId);
    if (!existing || listeningStatusRank(state.status) > listeningStatusRank(existing.status)) {
      result.set(state.spotifyEpisodeId, state);
    }
  }
  return result;
}

function listeningStatusRank(
  status: Podcast06ListeningStateEvidence["status"],
): number {
  switch (status) {
    case "IN_PROGRESS":
      return 3;
    case "COMPLETED":
      return 2;
    case "NOT_STARTED":
      return 1;
  }
}

function excludedReason(
  authority:
    | "SHOW_OVERRIDE"
    | "SAVED_EPISODES_DEFAULT"
    | "LEGACY_SAVED_EPISODES"
    | undefined,
): Podcast07GlobalPoolExcludedFactualConsumption["reason"] {
  if (authority === "SHOW_OVERRIDE") return "SHOW_OVERRIDE";
  if (authority === "LEGACY_SAVED_EPISODES") return "LEGACY_SAVED_EPISODES";
  return "NOT_IN_CURRENT_SAVED_POOL";
}

function normalizedId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
