import { AsyncLocalStorage } from "node:async_hooks";

import type { PlanResult } from "./types";

export type Podcast09PlannerMode = "OFF" | "SHADOW" | "ACTIVE";
export type Podcast09PlannerActivationReason =
  | "MODE_OFF"
  | "MODE_SHADOW"
  | "ACTIVE_ALLOWED"
  | "ACTIVE_REAL_ALLOWED"
  | "ACTIVE_SIMULATION_ONLY"
  | "ACTIVE_MANUAL_ONLY"
  | "ACTIVE_SINGLE_TARGET_REQUIRED"
  | "ACTIVE_TARGET_NOT_ALLOWED"
  | "ACTIVE_PAIR_NOT_ALLOWED"
  | "INVALID_MODE";

export type Podcast09ShadowTargetStatus =
  | "SHADOW_READY"
  | "NO_CONTINUATION"
  | "ABSTAIN_NO_DESTINATION_EVIDENCE"
  | "ABSTAIN_MULTI_TARGET_SCOPE";

export type Podcast09ShadowTargetEvidence = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  status: Podcast09ShadowTargetStatus;
  plannerInfluence: boolean;
  currentDestinationEpisodeIds: string[];
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
  runtimeVersion: "podcast09-gate5-runtime-v1";
  requestedMode: Podcast09PlannerMode;
  effectiveMode: Podcast09PlannerMode;
  activationReason: Podcast09PlannerActivationReason;
  plannerInfluence: boolean;
  simulation: boolean;
  trigger: string | null;
  addedProviderCalls: false;
  behavioralDatabaseWrites: false;
  observabilitySummaryWrite: true;
  continuationInfluencedSpotifyWritePossible: boolean;
  targetAllowlist: string[];
  targets: Podcast09ShadowTargetEvidence[];
}>;

export type Podcast09ShadowRuntimeState = {
  allowedTargetIds: ReadonlySet<string>;
  currentDestinationEpisodeIdsByTargetId: ReadonlyMap<string, readonly string[]>;
  requestedMode: Podcast09PlannerMode;
  effectiveMode: Podcast09PlannerMode;
  activationReason: Podcast09PlannerActivationReason;
  evidence: Podcast09ShadowEvidence;
};

const storage = new AsyncLocalStorage<Podcast09ShadowRuntimeState>();

export function resolvePodcast09PlannerMode(input: {
  requestedMode?: string | null;
  simulate: boolean;
  trigger?: string | null;
  userId: string;
  targetScope?: readonly string[] | null;
  targetAllowlist?: string | null;
  activeAllowlist?: string | null;
  realActiveAllowlist?: string | null;
}): {
  requestedMode: Podcast09PlannerMode;
  effectiveMode: Podcast09PlannerMode;
  activationReason: Podcast09PlannerActivationReason;
} {
  const rawMode = input.requestedMode?.trim().toUpperCase() || "SHADOW";
  if (!["OFF", "SHADOW", "ACTIVE"].includes(rawMode)) {
    return {
      requestedMode: "OFF",
      effectiveMode: "OFF",
      activationReason: "INVALID_MODE",
    };
  }

  const requestedMode = rawMode as Podcast09PlannerMode;
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

  const targetScope = [
    ...new Set((input.targetScope ?? []).map((value) => value.trim()).filter(Boolean)),
  ];
  if (targetScope.length !== 1) {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_SINGLE_TARGET_REQUIRED",
    };
  }

  const targetId = targetScope[0]!;
  const targetAllowlist = parseTokenSet(input.targetAllowlist);
  if (!targetAllowlist.has(targetId)) {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_TARGET_NOT_ALLOWED",
    };
  }

  const activePair = `${input.userId}:${targetId}`;
  const activePairs = parseTokenSet(input.activeAllowlist);
  if (!activePairs.has(activePair)) {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_PAIR_NOT_ALLOWED",
    };
  }

  if (input.simulate) {
    return {
      requestedMode,
      effectiveMode: "ACTIVE",
      activationReason: "ACTIVE_ALLOWED",
    };
  }

  const realActivePairs = parseTokenSet(input.realActiveAllowlist);
  if (!realActivePairs.has(activePair)) {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_SIMULATION_ONLY",
    };
  }

  if (input.trigger !== "MANUAL") {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_MANUAL_ONLY",
    };
  }

  return {
    requestedMode,
    effectiveMode: "ACTIVE",
    activationReason: "ACTIVE_REAL_ALLOWED",
  };
}

export function createPodcast09ShadowRuntimeState(input: {
  targetAllowlist?: string | null;
  currentDestinationEpisodeIdsByTargetId?: Readonly<
    Record<string, readonly string[] | undefined>
  >;
  requestedMode?: string | null;
  simulate?: boolean;
  trigger?: string | null;
  userId?: string;
  targetScope?: readonly string[] | null;
  activeAllowlist?: string | null;
  realActiveAllowlist?: string | null;
}): Podcast09ShadowRuntimeState {
  const allowedTargetIds = parseTokenSet(input.targetAllowlist);
  const targetAllowlist = [...allowedTargetIds].sort();
  const currentDestinationEpisodeIdsByTargetId = new Map<string, readonly string[]>();

  for (const [targetPlaylistId, episodeIds] of Object.entries(
    input.currentDestinationEpisodeIdsByTargetId ?? {},
  )) {
    if (!episodeIds) continue;
    currentDestinationEpisodeIdsByTargetId.set(
      targetPlaylistId,
      episodeIds.map((episodeId) => episodeId.trim()).filter(Boolean),
    );
  }

  const simulation = input.simulate ?? false;
  const trigger = input.trigger?.trim() || null;
  const mode = resolvePodcast09PlannerMode({
    requestedMode: input.requestedMode,
    simulate: simulation,
    trigger,
    userId: input.userId ?? "",
    targetScope: input.targetScope,
    targetAllowlist: input.targetAllowlist,
    activeAllowlist: input.activeAllowlist,
    realActiveAllowlist: input.realActiveAllowlist,
  });

  return {
    allowedTargetIds,
    currentDestinationEpisodeIdsByTargetId,
    ...mode,
    evidence: {
      runtimeVersion: "podcast09-gate5-runtime-v1",
      ...mode,
      plannerInfluence: false,
      simulation,
      trigger,
      addedProviderCalls: false,
      behavioralDatabaseWrites: false,
      observabilitySummaryWrite: true,
      continuationInfluencedSpotifyWritePossible:
        mode.effectiveMode === "ACTIVE" && !simulation,
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

export function podcast09ShadowCurrentDestinationEpisodeIds(
  targetPlaylistId: string,
): readonly string[] | undefined {
  return currentPodcast09ShadowRuntimeState()?.currentDestinationEpisodeIdsByTargetId.get(
    targetPlaylistId,
  );
}

export function recordPodcast09ShadowAbstention(input: {
  targetPlaylistId: string;
  targetName: string;
  status: Extract<
    Podcast09ShadowTargetStatus,
    "ABSTAIN_NO_DESTINATION_EVIDENCE" | "ABSTAIN_MULTI_TARGET_SCOPE"
  >;
}): void {
  const state = currentPodcast09ShadowRuntimeState();
  if (!state) return;
  upsertTarget(state, {
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    status: input.status,
    plannerInfluence: false,
    currentDestinationEpisodeIds: [],
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
  currentDestinationEpisodeIds: readonly string[];
  continuationCandidateCount: number;
  promotedEpisodeIds: readonly string[];
  selectedEpisodeId: string | null;
  movedCount: number;
  currentPoolEpisodeIds: readonly string[];
  projectedPoolEpisodeIds: readonly string[];
  currentPlan: PlanResult;
  projectedPlan: PlanResult;
  plannerInfluence?: boolean;
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
  const planChanged =
    currentPlannedPodcastEpisodeIds.join("\n") !==
    projectedPlannedPodcastEpisodeIds.join("\n");
  const plannerInfluence = Boolean(
    input.plannerInfluence && input.continuationCandidateCount > 0 && planChanged,
  );

  upsertTarget(state, {
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    status:
      input.continuationCandidateCount > 0 ? "SHADOW_READY" : "NO_CONTINUATION",
    plannerInfluence,
    currentDestinationEpisodeIds: [...input.currentDestinationEpisodeIds],
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
    planChanged,
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
    plannerInfluence: targets.some((entry) => entry.plannerInfluence),
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

function parseTokenSet(value?: string | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[,;\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}
