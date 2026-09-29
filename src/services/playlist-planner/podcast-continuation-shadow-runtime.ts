import { AsyncLocalStorage } from "node:async_hooks";

import type { PlanResult } from "./types";
import type { PodcastContinuationListeningState } from "./podcast-continuation-priority";

export type Podcast09ShadowTargetStatus =
  | "SHADOW_READY"
  | "NO_CONTINUATION"
  | "ABSTAIN_MULTI_TARGET_SCOPE";

export type Podcast09ShadowTargetEvidence = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  status: Podcast09ShadowTargetStatus;
  plannerInfluence: false;
  continuationCandidateCount: number;
  promotedEpisodeIds: string[];
  selectedEpisodeId: string | null;
  movedCount: number;
  currentPoolEpisodeIds: string[];
  projectedPoolEpisodeIds: string[];
  currentPlannedPodcastEpisodeIds: string[];
  projectedPlannedPodcastEpisodeIds: string[];
  currentSelectedPlanPosition: number | null;
  projectedSelectedPlanPosition: number | null;
  currentFirstPodcastEpisodeId: string | null;
  projectedFirstPodcastEpisodeId: string | null;
  planChanged: boolean;
}>;

export type Podcast09ShadowEvidence = Readonly<{
  runtimeVersion: "podcast09-gate3-shadow-v1";
  plannerInfluence: false;
  providerCalls: false;
  databaseWrites: false;
  spotifyWrites: false;
  targetAllowlist: string[];
  targets: Podcast09ShadowTargetEvidence[];
}>;

export type Podcast09ShadowRuntimeState = {
  allowedTargetIds: ReadonlySet<string>;
  listeningStates: readonly PodcastContinuationListeningState[];
  evidence: Podcast09ShadowEvidence;
};

const storage = new AsyncLocalStorage<Podcast09ShadowRuntimeState>();

export function createPodcast09ShadowRuntimeState(input: {
  targetAllowlist?: string | null;
  listeningStates: readonly PodcastContinuationListeningState[];
}): Podcast09ShadowRuntimeState {
  const allowedTargetIds = new Set(
    (input.targetAllowlist ?? "")
      .split(/[,;\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const targetAllowlist = [...allowedTargetIds].sort();

  return {
    allowedTargetIds,
    listeningStates: [...input.listeningStates],
    evidence: {
      runtimeVersion: "podcast09-gate3-shadow-v1",
      plannerInfluence: false,
      providerCalls: false,
      databaseWrites: false,
      spotifyWrites: false,
      targetAllowlist,
      targets: [],
    },
  };
}

export function runWithPodcast09ShadowRuntimeState<T>(
  state: Podcast09ShadowRuntimeState,
  callback: () => T,
): T {
  return storage.run(state, callback);
}

export function currentPodcast09ShadowRuntimeState():
  | Podcast09ShadowRuntimeState
  | undefined {
  return storage.getStore();
}

export function podcast09ShadowRuntimeSummary(
  state: Podcast09ShadowRuntimeState,
): Podcast09ShadowEvidence {
  return state.evidence;
}

export function podcast09ShadowTargetIsAllowed(targetPlaylistId: string): boolean {
  const state = currentPodcast09ShadowRuntimeState();
  return Boolean(state?.allowedTargetIds.has(targetPlaylistId));
}

export function podcast09ShadowListeningStates(): readonly PodcastContinuationListeningState[] {
  return currentPodcast09ShadowRuntimeState()?.listeningStates ?? [];
}

export function recordPodcast09ShadowAbstention(input: {
  targetPlaylistId: string;
  targetName: string;
  status: Extract<Podcast09ShadowTargetStatus, "ABSTAIN_MULTI_TARGET_SCOPE">;
}): void {
  const state = currentPodcast09ShadowRuntimeState();
  if (!state) return;
  upsertTarget(state, {
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    status: input.status,
    plannerInfluence: false,
    continuationCandidateCount: 0,
    promotedEpisodeIds: [],
    selectedEpisodeId: null,
    movedCount: 0,
    currentPoolEpisodeIds: [],
    projectedPoolEpisodeIds: [],
    currentPlannedPodcastEpisodeIds: [],
    projectedPlannedPodcastEpisodeIds: [],
    currentSelectedPlanPosition: null,
    projectedSelectedPlanPosition: null,
    currentFirstPodcastEpisodeId: null,
    projectedFirstPodcastEpisodeId: null,
    planChanged: false,
  });
}

export function recordPodcast09ShadowComparison(input: {
  targetPlaylistId: string;
  targetName: string;
  continuationCandidateCount: number;
  promotedEpisodeIds: readonly string[];
  selectedEpisodeId: string | null;
  movedCount: number;
  currentPoolEpisodeIds: readonly string[];
  projectedPoolEpisodeIds: readonly string[];
  currentPlan: PlanResult;
  projectedPlan: PlanResult;
}): void {
  const state = currentPodcast09ShadowRuntimeState();
  if (!state) return;

  const currentPlannedPodcastEpisodeIds = plannedPodcastEpisodeIds(input.currentPlan);
  const projectedPlannedPodcastEpisodeIds = plannedPodcastEpisodeIds(input.projectedPlan);
  const selectedEpisodeId = input.selectedEpisodeId;
  const currentSelectedPlanPosition = selectedEpisodeId
    ? planEpisodePosition(input.currentPlan, selectedEpisodeId)
    : null;
  const projectedSelectedPlanPosition = selectedEpisodeId
    ? planEpisodePosition(input.projectedPlan, selectedEpisodeId)
    : null;

  upsertTarget(state, {
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    status:
      input.continuationCandidateCount > 0 ? "SHADOW_READY" : "NO_CONTINUATION",
    plannerInfluence: false,
    continuationCandidateCount: input.continuationCandidateCount,
    promotedEpisodeIds: [...input.promotedEpisodeIds],
    selectedEpisodeId,
    movedCount: input.movedCount,
    currentPoolEpisodeIds: [...input.currentPoolEpisodeIds],
    projectedPoolEpisodeIds: [...input.projectedPoolEpisodeIds],
    currentPlannedPodcastEpisodeIds,
    projectedPlannedPodcastEpisodeIds,
    currentSelectedPlanPosition,
    projectedSelectedPlanPosition,
    currentFirstPodcastEpisodeId: currentPlannedPodcastEpisodeIds[0] ?? null,
    projectedFirstPodcastEpisodeId: projectedPlannedPodcastEpisodeIds[0] ?? null,
    planChanged:
      currentPlannedPodcastEpisodeIds.join("\n") !==
      projectedPlannedPodcastEpisodeIds.join("\n"),
  });
}

function upsertTarget(
  state: Podcast09ShadowRuntimeState,
  evidence: Podcast09ShadowTargetEvidence,
): void {
  const targets = state.evidence.targets.filter(
    (entry) => entry.targetPlaylistId !== evidence.targetPlaylistId,
  );
  targets.push(evidence);
  state.evidence = {
    ...state.evidence,
    targets,
  };
}

function plannedPodcastEpisodeIds(plan: PlanResult): string[] {
  return plan.items.flatMap((item) =>
    item.type === "PODCAST" && item.spotifyEpisodeId ? [item.spotifyEpisodeId] : [],
  );
}

function planEpisodePosition(plan: PlanResult, episodeId: string): number | null {
  const item = plan.items.find(
    (candidate) =>
      candidate.type === "PODCAST" && candidate.spotifyEpisodeId === episodeId,
  );
  return item ? item.position : null;
}
