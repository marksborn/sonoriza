import { AsyncLocalStorage } from "node:async_hooks";

import type { PodcastShowCadencePolicySnapshot } from "@/services/spotify/podcast-show-cadence-policy-store";
import {
  evaluatePodcastShowCadenceShadow,
  type PodcastCadenceEvidence,
  type PodcastCadenceListeningStatus,
} from "@/services/spotify/podcast-show-cadence-shadow";

import type { Candidate } from "./types";

export type Podcast06ListeningStateEvidence = Readonly<{
  spotifyEpisodeId: string;
  spotifyShowId: string | null;
  status: PodcastCadenceListeningStatus;
  firstProgressObservedAt: Date | null;
}>;

export type Podcast06PlannerMode = "OFF" | "SHADOW" | "ACTIVE";

export type Podcast06PlannerActivationReason =
  | "MODE_OFF"
  | "MODE_SHADOW"
  | "ACTIVE_ALLOWED"
  | "ACTIVE_EMAIL_NOT_ALLOWED"
  | "INVALID_MODE";

export type Podcast06PlannerShadowStatus =
  | "NO_POLICY"
  | "NOT_OBSERVED"
  | "ABSTAIN_TIMEZONE_UNAVAILABLE"
  | "ABSTAIN_INCOMPLETE_SHOW_PROVENANCE"
  | "ABSTAIN_INCOMPLETE_CANDIDATE_SHOW_PROVENANCE"
  | "READY_SHADOW";

export type Podcast06ShowShadowEvidence = Readonly<{
  spotifyShowId: string;
  showName: string | null;
  cadenceMaxEpisodes: number | null;
  cadenceUnit: "DAY" | "WEEK" | "MONTH" | null;
  priority: "NORMAL" | "PRIORITY";
  candidateCount: number;
  consumedCount: number | null;
  limitReached: boolean | null;
  newEpisodeAllowedByCadence: boolean | null;
  inProgressContinuationEpisodeIds: string[];
  projectedBlockedEpisodeIds: string[];
  diagnosticCodes: string[];
}>;

export type Podcast06PlannerShadowEvidence = Readonly<{
  policyVersion: "podcast06-gate4-shadow-v1";
  runtimeVersion: "podcast06-gate5a-runtime-v1";
  status: Podcast06PlannerShadowStatus;
  requestedMode: Podcast06PlannerMode;
  effectiveMode: Podcast06PlannerMode;
  activationReason: Podcast06PlannerActivationReason;
  plannerInfluence: boolean;
  databaseWrites: false;
  spotifyWrites: false;
  timeZone: string | null;
  asOf: string;
  configuredPolicyCount: number;
  candidateCount: number;
  candidateWithShowIdentityCount: number;
  listeningStateCount: number;
  resolvedListeningStateCount: number;
  unresolvedStateCount: number;
  unresolvedFactualCount: number;
  projectedPriorityMovedCount: number;
  projectedPriorityOrderEpisodeIds: string[];
  actualPoolOrderEpisodeIds: string[];
  plannedPodcastEpisodeIds: string[];
  shows: Podcast06ShowShadowEvidence[];
}>;

export type Podcast06PlannerShadowRuntimeState = {
  policies: ReadonlyMap<string, PodcastShowCadencePolicySnapshot>;
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  timeZone: string | null;
  asOf: Date;
  requestedMode: Podcast06PlannerMode;
  effectiveMode: Podcast06PlannerMode;
  activationReason: Podcast06PlannerActivationReason;
  evidence: Podcast06PlannerShadowEvidence;
};

type Podcast06Projection = {
  evidence: Podcast06PlannerShadowEvidence;
  projectedCandidates: Candidate[];
};

const storage = new AsyncLocalStorage<Podcast06PlannerShadowRuntimeState>();

export function resolvePodcast06PlannerMode(input: {
  requestedMode?: string | null;
  userEmail?: string | null;
  activeEmailAllowlist?: string | null;
}): {
  requestedMode: Podcast06PlannerMode;
  effectiveMode: Podcast06PlannerMode;
  activationReason: Podcast06PlannerActivationReason;
} {
  const rawMode = normalizedOptionalText(input.requestedMode)?.toUpperCase() ?? null;
  if (rawMode !== null && !["OFF", "SHADOW", "ACTIVE"].includes(rawMode)) {
    return {
      requestedMode: "OFF",
      effectiveMode: "OFF",
      activationReason: "INVALID_MODE",
    };
  }

  const requestedMode = (rawMode ?? "SHADOW") as Podcast06PlannerMode;
  if (requestedMode === "OFF") {
    return { requestedMode, effectiveMode: "OFF", activationReason: "MODE_OFF" };
  }
  if (requestedMode === "SHADOW") {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "MODE_SHADOW",
    };
  }

  const userEmail = normalizedOptionalText(input.userEmail)?.toLowerCase() ?? null;
  const allowlist = new Set(
    (input.activeEmailAllowlist ?? "")
      .split(/[,;\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (userEmail && allowlist.has(userEmail)) {
    return {
      requestedMode,
      effectiveMode: "ACTIVE",
      activationReason: "ACTIVE_ALLOWED",
    };
  }
  return {
    requestedMode,
    effectiveMode: "SHADOW",
    activationReason: "ACTIVE_EMAIL_NOT_ALLOWED",
  };
}

export function createPodcast06PlannerShadowRuntimeState(input: {
  policies: ReadonlyMap<string, PodcastShowCadencePolicySnapshot>;
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  timeZone: string | null;
  asOf: Date;
  requestedMode?: string | null;
  userEmail?: string | null;
  activeEmailAllowlist?: string | null;
}): Podcast06PlannerShadowRuntimeState {
  const timeZone = normalizedOptionalText(input.timeZone);
  const mode = resolvePodcast06PlannerMode({
    requestedMode: input.requestedMode,
    userEmail: input.userEmail,
    activeEmailAllowlist: input.activeEmailAllowlist,
  });
  return {
    policies: input.policies,
    listeningStates: input.listeningStates,
    timeZone,
    asOf: input.asOf,
    ...mode,
    evidence: emptyEvidence({
      policyCount: input.policies.size,
      listeningStateCount: input.listeningStates.length,
      unresolvedFactualListeningStateCount: input.listeningStates.filter(
        (entry) =>
          entry.firstProgressObservedAt !== null &&
          normalizedOptionalText(entry.spotifyShowId) === null,
      ).length,
      timeZone,
      asOf: input.asOf,
      ...mode,
    }),
  };
}

export function runWithPodcast06PlannerShadowRuntimeState<T>(
  state: Podcast06PlannerShadowRuntimeState,
  callback: () => T,
): T {
  return storage.run(state, callback);
}

export function currentPodcast06PlannerShadowRuntimeState():
  | Podcast06PlannerShadowRuntimeState
  | undefined {
  return storage.getStore();
}

/**
 * Gate 5A productive seam. OFF is a strict no-op. SHADOW calculates the same
 * projection but returns the original pool. ACTIVE can replace the podcast pool
 * only when the projection is READY_SHADOW; every abstention returns the exact
 * original candidates, so incomplete provenance cannot under-enforce cadence.
 */
export function applyPodcast06PlannerRuntimeToCandidates(
  candidates: readonly Candidate[],
): Candidate[] {
  const state = currentPodcast06PlannerShadowRuntimeState();
  if (!state || state.effectiveMode === "OFF") return [...candidates];

  const projection = buildPodcast06Projection({
    policies: state.policies,
    listeningStates: state.listeningStates,
    timeZone: state.timeZone,
    asOf: state.asOf,
    candidates,
  });
  const plannerInfluence =
    state.effectiveMode === "ACTIVE" &&
    projection.evidence.status === "READY_SHADOW";
  state.evidence = runtimeEvidence(state, projection.evidence, plannerInfluence);
  return plannerInfluence ? projection.projectedCandidates : [...candidates];
}

/**
 * planRun calls this after planning so the final GenerationRun summary contains
 * the exact original pool projection plus the podcast episodes actually chosen.
 */
export function capturePodcast06PlannerShadow(input: {
  candidates: readonly Candidate[];
  plannedItems: readonly Candidate[];
}): void {
  const state = currentPodcast06PlannerShadowRuntimeState();
  if (!state || state.effectiveMode === "OFF") return;
  const projection = buildPodcast06Projection({
    policies: state.policies,
    listeningStates: state.listeningStates,
    timeZone: state.timeZone,
    asOf: state.asOf,
    candidates: input.candidates,
    plannedItems: input.plannedItems,
  });
  const plannerInfluence =
    state.effectiveMode === "ACTIVE" &&
    projection.evidence.status === "READY_SHADOW";
  state.evidence = runtimeEvidence(state, projection.evidence, plannerInfluence);
}

export function podcast06PlannerShadowRuntimeSummary(
  state: Podcast06PlannerShadowRuntimeState,
): Podcast06PlannerShadowEvidence {
  return state.evidence;
}

export function projectPodcast06PlannerShadow(input: {
  policies: ReadonlyMap<string, PodcastShowCadencePolicySnapshot>;
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  timeZone: string | null;
  asOf: Date;
  candidates: readonly Candidate[];
  plannedItems?: readonly Candidate[];
}): Podcast06PlannerShadowEvidence {
  return buildPodcast06Projection(input).evidence;
}

function buildPodcast06Projection(input: {
  policies: ReadonlyMap<string, PodcastShowCadencePolicySnapshot>;
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  timeZone: string | null;
  asOf: Date;
  candidates: readonly Candidate[];
  plannedItems?: readonly Candidate[];
}): Podcast06Projection {
  const podcastCandidates = input.candidates.filter(
    (candidate) => candidate.type === "PODCAST",
  );
  const candidateWithShowIdentityCount = podcastCandidates.filter(
    (candidate) => Boolean(normalizedOptionalText(candidate.programId)),
  ).length;
  const episodeToShow = new Map<string, string>();
  for (const candidate of podcastCandidates) {
    const programId = normalizedOptionalText(candidate.programId);
    if (candidate.spotifyEpisodeId && programId) {
      episodeToShow.set(candidate.spotifyEpisodeId, programId);
    }
  }

  const cadenceEvidence: PodcastCadenceEvidence[] = [];
  let resolvedListeningStateCount = 0;
  let unresolvedFactualCount = 0;
  for (const listeningState of input.listeningStates) {
    const spotifyShowId =
      normalizedOptionalText(listeningState.spotifyShowId) ??
      episodeToShow.get(listeningState.spotifyEpisodeId) ??
      null;
    if (spotifyShowId) resolvedListeningStateCount += 1;
    else if (listeningState.firstProgressObservedAt) unresolvedFactualCount += 1;
    cadenceEvidence.push({
      spotifyEpisodeId: listeningState.spotifyEpisodeId,
      spotifyShowId,
      status: listeningState.status,
      firstProgressObservedAt: listeningState.firstProgressObservedAt,
    });
  }

  const unresolvedStateCount =
    input.listeningStates.length - resolvedListeningStateCount;
  const timeZone = normalizedOptionalText(input.timeZone);
  const status: Podcast06PlannerShadowStatus =
    input.policies.size === 0
      ? "NO_POLICY"
      : !timeZone
        ? "ABSTAIN_TIMEZONE_UNAVAILABLE"
        : unresolvedFactualCount > 0
          ? "ABSTAIN_INCOMPLETE_SHOW_PROVENANCE"
          : candidateWithShowIdentityCount !== podcastCandidates.length
            ? "ABSTAIN_INCOMPLETE_CANDIDATE_SHOW_PROVENANCE"
            : "READY_SHADOW";

  const showEvidence: Podcast06ShowShadowEvidence[] = [];
  const blockedNewPodcastShowIds = new Set<string>();

  for (const policy of [...input.policies.values()].sort((a, b) =>
    a.spotifyShowId.localeCompare(b.spotifyShowId),
  )) {
    const showCandidates = podcastCandidates.filter(
      (candidate) => candidate.programId === policy.spotifyShowId,
    );
    const continuationIds = showCandidates
      .filter(
        (candidate) =>
          candidate.podcastListeningStatus === "IN_PROGRESS" &&
          Boolean(candidate.spotifyEpisodeId),
      )
      .map((candidate) => candidate.spotifyEpisodeId!)
      .sort();

    let consumedCount: number | null = null;
    let limitReached: boolean | null = null;
    let newEpisodeAllowedByCadence: boolean | null = null;
    const projectedBlocked: string[] = [];
    const diagnosticCodes: string[] = [];

    const cadenceConfigured =
      policy.cadenceMaxEpisodes !== null && policy.cadenceUnit !== null;
    if (cadenceConfigured && status === "READY_SHADOW" && timeZone !== null) {
      const evaluation = evaluatePodcastShowCadenceShadow({
        evidence: cadenceEvidence,
        showId: policy.spotifyShowId,
        maxEpisodes: policy.cadenceMaxEpisodes!,
        unit: policy.cadenceUnit!,
        timeZone,
        asOf: input.asOf,
      });
      consumedCount = evaluation.consumedCount;
      limitReached = evaluation.limitReached;
      newEpisodeAllowedByCadence = evaluation.newEpisodeAllowedByCadence;

      if (evaluation.limitReached) {
        diagnosticCodes.push("SHOW_CADENCE_LIMIT_REACHED");
        blockedNewPodcastShowIds.add(policy.spotifyShowId);
        for (const candidate of showCandidates) {
          if (
            candidate.podcastListeningStatus !== "IN_PROGRESS" &&
            candidate.spotifyEpisodeId
          ) {
            projectedBlocked.push(candidate.spotifyEpisodeId);
          }
        }
      }
      if (continuationIds.length > 0) {
        diagnosticCodes.push("SHOW_CADENCE_IN_PROGRESS_CONTINUATION");
      }
    }

    if (policy.priority === "PRIORITY" && showCandidates.length > 0) {
      diagnosticCodes.push("SHOW_PRIORITY_APPLIED");
    }

    showEvidence.push({
      spotifyShowId: policy.spotifyShowId,
      showName: policy.showName,
      cadenceMaxEpisodes: policy.cadenceMaxEpisodes,
      cadenceUnit: policy.cadenceUnit,
      priority: policy.priority,
      candidateCount: showCandidates.length,
      consumedCount,
      limitReached,
      newEpisodeAllowedByCadence,
      inProgressContinuationEpisodeIds: continuationIds,
      projectedBlockedEpisodeIds: projectedBlocked.sort(),
      diagnosticCodes,
    });
  }

  const eligibleCandidates = podcastCandidates.filter((candidate) => {
    const programId = normalizedOptionalText(candidate.programId);
    if (!programId || !blockedNewPodcastShowIds.has(programId)) return true;
    return candidate.podcastListeningStatus === "IN_PROGRESS";
  });
  const projected = stablePriorityProjection(eligibleCandidates, input.policies);
  const actualPoolOrderEpisodeIds = eligibleCandidates.flatMap((candidate) =>
    candidate.spotifyEpisodeId ? [candidate.spotifyEpisodeId] : [],
  );
  const projectedPriorityOrderEpisodeIds = projected.flatMap((candidate) =>
    candidate.spotifyEpisodeId ? [candidate.spotifyEpisodeId] : [],
  );
  const projectedPriorityMovedCount = projectedPriorityOrderEpisodeIds.reduce(
    (count, episodeId, index) =>
      count + (actualPoolOrderEpisodeIds[index] === episodeId ? 0 : 1),
    0,
  );

  return {
    projectedCandidates: projected,
    evidence: {
      policyVersion: "podcast06-gate4-shadow-v1",
      runtimeVersion: "podcast06-gate5a-runtime-v1",
      status,
      requestedMode: "SHADOW",
      effectiveMode: "SHADOW",
      activationReason: "MODE_SHADOW",
      plannerInfluence: false,
      databaseWrites: false,
      spotifyWrites: false,
      timeZone,
      asOf: input.asOf.toISOString(),
      configuredPolicyCount: input.policies.size,
      candidateCount: podcastCandidates.length,
      candidateWithShowIdentityCount,
      listeningStateCount: input.listeningStates.length,
      resolvedListeningStateCount,
      unresolvedStateCount,
      unresolvedFactualCount,
      projectedPriorityMovedCount,
      projectedPriorityOrderEpisodeIds,
      actualPoolOrderEpisodeIds,
      plannedPodcastEpisodeIds: (input.plannedItems ?? []).flatMap((candidate) =>
        candidate.type === "PODCAST" && candidate.spotifyEpisodeId
          ? [candidate.spotifyEpisodeId]
          : [],
      ),
      shows: showEvidence,
    },
  };
}

function runtimeEvidence(
  state: Podcast06PlannerShadowRuntimeState,
  evidence: Podcast06PlannerShadowEvidence,
  plannerInfluence: boolean,
): Podcast06PlannerShadowEvidence {
  return {
    ...evidence,
    requestedMode: state.requestedMode,
    effectiveMode: state.effectiveMode,
    activationReason: state.activationReason,
    plannerInfluence,
  };
}

function stablePriorityProjection(
  candidates: readonly Candidate[],
  policies: ReadonlyMap<string, PodcastShowCadencePolicySnapshot>,
): Candidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      rank:
        candidate.programId && policies.get(candidate.programId)?.priority === "PRIORITY"
          ? 0
          : 1,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.candidate);
}

function emptyEvidence(input: {
  policyCount: number;
  listeningStateCount: number;
  unresolvedFactualListeningStateCount: number;
  timeZone: string | null;
  asOf: Date;
  requestedMode: Podcast06PlannerMode;
  effectiveMode: Podcast06PlannerMode;
  activationReason: Podcast06PlannerActivationReason;
}): Podcast06PlannerShadowEvidence {
  return {
    policyVersion: "podcast06-gate4-shadow-v1",
    runtimeVersion: "podcast06-gate5a-runtime-v1",
    status:
      input.policyCount === 0
        ? "NO_POLICY"
        : !input.timeZone
          ? "ABSTAIN_TIMEZONE_UNAVAILABLE"
          : "NOT_OBSERVED",
    requestedMode: input.requestedMode,
    effectiveMode: input.effectiveMode,
    activationReason: input.activationReason,
    plannerInfluence: false,
    databaseWrites: false,
    spotifyWrites: false,
    timeZone: input.timeZone,
    asOf: input.asOf.toISOString(),
    configuredPolicyCount: input.policyCount,
    candidateCount: 0,
    candidateWithShowIdentityCount: 0,
    listeningStateCount: input.listeningStateCount,
    resolvedListeningStateCount: 0,
    unresolvedStateCount: input.listeningStateCount,
    unresolvedFactualCount: input.unresolvedFactualListeningStateCount,
    projectedPriorityMovedCount: 0,
    projectedPriorityOrderEpisodeIds: [],
    actualPoolOrderEpisodeIds: [],
    plannedPodcastEpisodeIds: [],
    shows: [],
  };
}

function normalizedOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
