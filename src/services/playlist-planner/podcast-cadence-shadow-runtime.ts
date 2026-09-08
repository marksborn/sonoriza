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

export type Podcast06PlannerShadowStatus =
  | "NO_POLICY"
  | "NOT_OBSERVED"
  | "ABSTAIN_TIMEZONE_UNAVAILABLE"
  | "ABSTAIN_INCOMPLETE_SHOW_PROVENANCE"
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
  status: Podcast06PlannerShadowStatus;
  plannerInfluence: false;
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
  evidence: Podcast06PlannerShadowEvidence;
};

const storage = new AsyncLocalStorage<Podcast06PlannerShadowRuntimeState>();

export function createPodcast06PlannerShadowRuntimeState(input: {
  policies: ReadonlyMap<string, PodcastShowCadencePolicySnapshot>;
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  timeZone: string | null;
  asOf: Date;
}): Podcast06PlannerShadowRuntimeState {
  const timeZone = normalizedOptionalText(input.timeZone);
  return {
    policies: input.policies,
    listeningStates: input.listeningStates,
    timeZone,
    asOf: input.asOf,
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
 * Gate 4 observation seam. planRun calls this with the exact podcast pool it
 * received and the resulting planned items. The projection is diagnostic only:
 * it never returns a replacement pool/order and therefore cannot influence the
 * productive plan.
 */
export function capturePodcast06PlannerShadow(input: {
  candidates: readonly Candidate[];
  plannedItems: readonly Candidate[];
}): void {
  const state = currentPodcast06PlannerShadowRuntimeState();
  if (!state) return;
  state.evidence = projectPodcast06PlannerShadow({
    policies: state.policies,
    listeningStates: state.listeningStates,
    timeZone: state.timeZone,
    asOf: state.asOf,
    candidates: input.candidates,
    plannedItems: input.plannedItems,
  });
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
  const podcastCandidates = input.candidates.filter(
    (candidate) => candidate.type === "PODCAST",
  );
  const episodeToShow = new Map<string, string>();
  for (const candidate of podcastCandidates) {
    if (candidate.spotifyEpisodeId && candidate.programId) {
      episodeToShow.set(candidate.spotifyEpisodeId, candidate.programId);
    }
  }

  const evidence: PodcastCadenceEvidence[] = [];
  let resolvedListeningStateCount = 0;
  let unresolvedFactualCount = 0;
  for (const listeningState of input.listeningStates) {
    const spotifyShowId =
      normalizedOptionalText(listeningState.spotifyShowId) ??
      episodeToShow.get(listeningState.spotifyEpisodeId) ??
      null;
    if (spotifyShowId) resolvedListeningStateCount += 1;
    else if (listeningState.firstProgressObservedAt) unresolvedFactualCount += 1;
    evidence.push({
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
          : "READY_SHADOW";

  const showEvidence: Podcast06ShowShadowEvidence[] = [];
  const blockedEpisodeIds = new Set<string>();

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
    if (
      cadenceConfigured &&
      status === "READY_SHADOW" &&
      timeZone !== null
    ) {
      const evaluation = evaluatePodcastShowCadenceShadow({
        evidence,
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
        for (const candidate of showCandidates) {
          if (
            candidate.podcastListeningStatus !== "IN_PROGRESS" &&
            candidate.spotifyEpisodeId
          ) {
            projectedBlocked.push(candidate.spotifyEpisodeId);
            blockedEpisodeIds.add(candidate.spotifyEpisodeId);
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

  const eligibleCandidates = podcastCandidates.filter(
    (candidate) =>
      !candidate.spotifyEpisodeId || !blockedEpisodeIds.has(candidate.spotifyEpisodeId),
  );
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
    policyVersion: "podcast06-gate4-shadow-v1",
    status,
    plannerInfluence: false,
    databaseWrites: false,
    spotifyWrites: false,
    timeZone,
    asOf: input.asOf.toISOString(),
    configuredPolicyCount: input.policies.size,
    candidateCount: podcastCandidates.length,
    candidateWithShowIdentityCount: podcastCandidates.filter(
      (candidate) => Boolean(candidate.programId),
    ).length,
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
}): Podcast06PlannerShadowEvidence {
  return {
    policyVersion: "podcast06-gate4-shadow-v1",
    status:
      input.policyCount === 0
        ? "NO_POLICY"
        : !input.timeZone
          ? "ABSTAIN_TIMEZONE_UNAVAILABLE"
          : "NOT_OBSERVED",
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
