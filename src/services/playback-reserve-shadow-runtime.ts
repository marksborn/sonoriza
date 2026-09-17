import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  loadEffectivePlaybackReservePolicy,
  type EffectivePlaybackReservePolicySnapshot,
} from "@/services/playback-reserve-policy";
import type { PlaybackReserveGate8KeepFilledContext } from "@/services/playback-reserve-gate8";
import type { PlaybackReserveRunShadowEvidence } from "@/services/playlist-planner/plan-run-playback-reserve";

export type PlaybackReserveRuntimeMode = "OFF" | "SHADOW" | "ACTIVE";
export type PlaybackReserveMaintenanceMode = "REBUILD_DAILY" | "KEEP_FILLED";
export type PlaybackReserveRuntimeStatus =
  | "OFF"
  | "READY_SHADOW"
  | "READY_ACTIVE_SIMULATION"
  | "READY_ACTIVE_REAL"
  | "ABSTAIN_ACTIVE_SCOPE_REQUIRED"
  | "ABSTAIN_TARGET_NOT_ALLOWED"
  | "ABSTAIN_UPDATE_POLICY_UNSUPPORTED"
  | "ABSTAIN_KEEP_FILLED_CONTEXT_REQUIRED"
  | "ABSTAIN_SIMULATION_REQUIRED";
export type PlaybackReserveRolePersistenceStatus =
  | "NOT_APPLICABLE"
  | "PENDING"
  | "PERSISTED"
  | "FAILED";

/**
 * Gate 8 extends the Gate 7 runtime while retaining the historical Gate 5/7
 * fixture surface for older tests/callers. Runtime preparation always returns
 * the complete Gate 8 shape.
 */
export type PlaybackReserveShadowRuntimeState = {
  gate: 5 | 7 | 8;
  mode?: "SHADOW";
  configuredMode?: PlaybackReserveRuntimeMode;
  effectiveMode?: PlaybackReserveRuntimeMode;
  simulate?: boolean;
  plannerInfluence: boolean;
  spotifyWriteInfluence: boolean;
  additionalProviderReads: boolean;
  status?: PlaybackReserveRuntimeStatus;
  targetPlaylistIds?: readonly string[];
  allowedTargetIds?: ReadonlySet<string>;
  policies: ReadonlyMap<string, EffectivePlaybackReservePolicySnapshot>;
  maintenanceMode?: PlaybackReserveMaintenanceMode | null;
  keepFilledSnapshotBefore?: string | null;
  keepFilledPreviousRunId?: string | null;
  keepFilledPreviousReserveCount?: number;
  keepFilledPreviousReserveDurationMs?: number;
  simulationApprovalKey?: string | null;
  simulationApprovedRunId?: string | null;
  inlineSimulationRunId?: string | null;
  inlineSimulationStatus?: string | null;
  rolePersistenceStatus?: PlaybackReserveRolePersistenceStatus;
  reserveRoleCount?: number;
  evidence: PlaybackReserveRunShadowEvidence | null;
};

const storage = new AsyncLocalStorage<PlaybackReserveShadowRuntimeState>();

export async function preparePlaybackReserveShadowRuntime(input: {
  userId: string;
  targetPlaylistIds?: readonly string[];
  simulate?: boolean;
  scheduledPolicyByTargetId?: Readonly<
    Record<string, "KEEP_FILLED" | "REBUILD_DAILY">
  >;
  keepFilledContextByTargetId?: Readonly<
    Record<string, PlaybackReserveGate8KeepFilledContext>
  >;
}): Promise<PlaybackReserveShadowRuntimeState> {
  const simulate = input.simulate ?? false;
  const configuredMode = parseRuntimeMode(process.env.PLAYBACK_RESERVE_RUNTIME_MODE);
  const allowedTargetIds = parseIdSet(process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS);

  const requestedTargetIds = input.targetPlaylistIds
    ? [...new Set(input.targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : null;

  const targets = await prisma.targetPlaylist.findMany({
    where: {
      userId: input.userId,
      ...(requestedTargetIds
        ? { id: { in: requestedTargetIds } }
        : { enabled: true }),
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: { id: true, updatePolicy: true },
  });
  const targetPlaylistIds = targets.map((target) => target.id);

  const policies = await Promise.all(
    targetPlaylistIds.map(async (targetPlaylistId) => [
      targetPlaylistId,
      await loadEffectivePlaybackReservePolicy(input.userId, targetPlaylistId),
    ] as const),
  );
  const policyMap = new Map(policies);
  const singleTarget = targets.length === 1 ? targets[0]! : null;
  const maintenanceMode = singleTarget
    ? normalizeMaintenanceMode(singleTarget.updatePolicy)
    : null;
  const keepFilledContext = singleTarget
    ? input.keepFilledContextByTargetId?.[singleTarget.id] ?? null
    : null;
  const key = approvalKey({
    targetPlaylistIds,
    policies: policyMap,
    maintenanceMode,
    keepFilledSnapshotBefore:
      maintenanceMode === "KEEP_FILLED" ? keepFilledContext?.snapshotBefore ?? null : null,
  });

  const base = {
    gate: 8 as const,
    configuredMode,
    simulate,
    additionalProviderReads: false,
    targetPlaylistIds,
    allowedTargetIds,
    policies: policyMap,
    maintenanceMode,
    keepFilledSnapshotBefore: keepFilledContext?.snapshotBefore ?? null,
    keepFilledPreviousRunId: keepFilledContext?.previousRunId ?? null,
    keepFilledPreviousReserveCount: keepFilledContext?.previousReserveCount ?? 0,
    keepFilledPreviousReserveDurationMs:
      keepFilledContext?.previousReserveDurationMs ?? 0,
    reserveRoleCount: 0,
    inlineSimulationRunId: null,
    inlineSimulationStatus: null,
    evidence: null,
  };

  if (configuredMode === "OFF") {
    return {
      ...base,
      effectiveMode: "OFF",
      plannerInfluence: false,
      spotifyWriteInfluence: false,
      status: "OFF",
      simulationApprovalKey: null,
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
  }

  if (configuredMode === "SHADOW") {
    return {
      ...base,
      effectiveMode: "SHADOW",
      plannerInfluence: false,
      spotifyWriteInfluence: false,
      status: "READY_SHADOW",
      simulationApprovalKey: key,
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
  }

  if (targetPlaylistIds.length !== 1 || !singleTarget) {
    return {
      ...base,
      effectiveMode: "SHADOW",
      plannerInfluence: false,
      spotifyWriteInfluence: false,
      status: "ABSTAIN_ACTIVE_SCOPE_REQUIRED",
      simulationApprovalKey: key,
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
  }

  if (!allowedTargetIds.has(singleTarget.id)) {
    return {
      ...base,
      effectiveMode: "SHADOW",
      plannerInfluence: false,
      spotifyWriteInfluence: false,
      status: "ABSTAIN_TARGET_NOT_ALLOWED",
      simulationApprovalKey: key,
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
  }

  if (!maintenanceMode) {
    return {
      ...base,
      effectiveMode: "SHADOW",
      plannerInfluence: false,
      spotifyWriteInfluence: false,
      status: "ABSTAIN_UPDATE_POLICY_UNSUPPORTED",
      simulationApprovalKey: key,
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
  }

  if (maintenanceMode === "KEEP_FILLED") {
    const scheduledPolicy = input.scheduledPolicyByTargetId?.[singleTarget.id];
    if (scheduledPolicy !== "KEEP_FILLED" || !keepFilledContext?.snapshotBefore) {
      return {
        ...base,
        effectiveMode: "SHADOW",
        plannerInfluence: false,
        spotifyWriteInfluence: false,
        status: "ABSTAIN_KEEP_FILLED_CONTEXT_REQUIRED",
        simulationApprovalKey: key,
        simulationApprovedRunId: null,
        rolePersistenceStatus: "NOT_APPLICABLE",
      };
    }
  }

  if (simulate) {
    return {
      ...base,
      effectiveMode: "ACTIVE",
      plannerInfluence: true,
      spotifyWriteInfluence: false,
      status: "READY_ACTIVE_SIMULATION",
      simulationApprovalKey: key,
      simulationApprovedRunId: null,
      rolePersistenceStatus: "PENDING",
    };
  }

  const approvedRunId = await findApprovedGate8Simulation({
    userId: input.userId,
    targetPlaylistId: singleTarget.id,
    approvalKey: key,
  });
  if (!approvedRunId) {
    return {
      ...base,
      effectiveMode: "SHADOW",
      plannerInfluence: false,
      spotifyWriteInfluence: false,
      status: "ABSTAIN_SIMULATION_REQUIRED",
      simulationApprovalKey: key,
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
  }

  return {
    ...base,
    effectiveMode: "ACTIVE",
    plannerInfluence: true,
    spotifyWriteInfluence: true,
    status: "READY_ACTIVE_REAL",
    simulationApprovalKey: key,
    simulationApprovedRunId: approvedRunId,
    rolePersistenceStatus: "PENDING",
  };
}

export function playbackReserveKeepFilledNeedsInlineSimulation(
  state: PlaybackReserveShadowRuntimeState,
): boolean {
  return Boolean(
    state.gate === 8 &&
      state.configuredMode === "ACTIVE" &&
      state.maintenanceMode === "KEEP_FILLED" &&
      state.status === "ABSTAIN_SIMULATION_REQUIRED" &&
      state.keepFilledSnapshotBefore,
  );
}

export function runWithPlaybackReserveShadowRuntimeState<T>(
  state: PlaybackReserveShadowRuntimeState,
  fn: () => T,
): T {
  return storage.run(state, fn);
}

export function currentPlaybackReserveShadowRuntimeState():
  | PlaybackReserveShadowRuntimeState
  | null {
  return storage.getStore() ?? null;
}

export function recordPlaybackReserveShadowEvidence(
  evidence: PlaybackReserveRunShadowEvidence,
): void {
  const state = storage.getStore();
  if (!state) return;
  state.evidence = evidence;
}

export function playbackReserveShadowRuntimeSummary(
  state: PlaybackReserveShadowRuntimeState,
) {
  return {
    gate: state.gate,
    configuredMode: state.configuredMode ?? state.mode ?? "SHADOW",
    effectiveMode: state.effectiveMode ?? "SHADOW",
    simulate: state.simulate ?? false,
    plannerInfluence: state.plannerInfluence,
    spotifyWriteInfluence: state.spotifyWriteInfluence,
    additionalProviderReads: state.additionalProviderReads,
    status: state.status ?? "READY_SHADOW",
    targetPlaylistIds: [...(state.targetPlaylistIds ?? [])],
    allowedTargetIds: [...(state.allowedTargetIds ?? new Set<string>())].sort(),
    maintenanceMode: state.maintenanceMode ?? null,
    keepFilledSnapshotBefore: state.keepFilledSnapshotBefore ?? null,
    keepFilledPreviousRunId: state.keepFilledPreviousRunId ?? null,
    keepFilledPreviousReserveCount: state.keepFilledPreviousReserveCount ?? 0,
    keepFilledPreviousReserveDurationMs:
      state.keepFilledPreviousReserveDurationMs ?? 0,
    simulationApprovalKey: state.simulationApprovalKey ?? null,
    simulationApprovedRunId: state.simulationApprovedRunId ?? null,
    inlineSimulationRunId: state.inlineSimulationRunId ?? null,
    inlineSimulationStatus: state.inlineSimulationStatus ?? null,
    rolePersistenceStatus: state.rolePersistenceStatus ?? "NOT_APPLICABLE",
    reserveRoleCount: state.reserveRoleCount ?? 0,
    evidence: state.evidence,
  };
}

export function playbackReserveRuntimeApprovalKey(input: {
  targetPlaylistIds: readonly string[];
  policies: ReadonlyMap<string, EffectivePlaybackReservePolicySnapshot>;
  maintenanceMode?: PlaybackReserveMaintenanceMode | null;
  keepFilledSnapshotBefore?: string | null;
}): string {
  return approvalKey({
    targetPlaylistIds: input.targetPlaylistIds,
    policies: input.policies,
    maintenanceMode: input.maintenanceMode ?? null,
    keepFilledSnapshotBefore: input.keepFilledSnapshotBefore ?? null,
  });
}

function parseRuntimeMode(raw: string | undefined): PlaybackReserveRuntimeMode {
  const value = raw?.trim().toUpperCase();
  if (!value || value === "SHADOW") return "SHADOW";
  if (value === "OFF" || value === "ACTIVE") return value;
  return "SHADOW";
}

function parseIdSet(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function normalizeMaintenanceMode(
  value: string,
): PlaybackReserveMaintenanceMode | null {
  if (value === "REBUILD_DAILY" || value === "KEEP_FILLED") return value;
  return null;
}

function approvalKey(input: {
  targetPlaylistIds: readonly string[];
  policies: ReadonlyMap<string, EffectivePlaybackReservePolicySnapshot>;
  maintenanceMode: PlaybackReserveMaintenanceMode | null;
  keepFilledSnapshotBefore: string | null;
}): string {
  const payload = [...input.targetPlaylistIds]
    .sort()
    .map((targetPlaylistId) => ({
      targetPlaylistId,
      policy: input.policies.get(targetPlaylistId) ?? null,
      maintenanceMode: input.maintenanceMode,
      keepFilledSnapshotBefore:
        input.maintenanceMode === "KEEP_FILLED"
          ? input.keepFilledSnapshotBefore
          : null,
    }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function findApprovedGate8Simulation(input: {
  userId: string;
  targetPlaylistId: string;
  approvalKey: string;
}): Promise<string | null> {
  const runs = await prisma.generationRun.findMany({
    where: {
      userId: input.userId,
      simulation: true,
      status: "SUCCESS",
    },
    orderBy: { startedAt: "desc" },
    take: 30,
    select: { id: true, summary: true },
  });

  for (const run of runs) {
    const summary = asRecord(run.summary);
    const runtime = asRecord(summary?.playbackReserveRuntime);
    if (!runtime) continue;
    if (runtime.gate !== 8) continue;
    if (runtime.effectiveMode !== "ACTIVE") continue;
    if (runtime.simulate !== true) continue;
    if (runtime.status !== "READY_ACTIVE_SIMULATION") continue;
    if (runtime.rolePersistenceStatus !== "PERSISTED") continue;
    if (runtime.simulationApprovalKey !== input.approvalKey) continue;
    const ids = Array.isArray(runtime.targetPlaylistIds)
      ? runtime.targetPlaylistIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    if (ids.length !== 1 || ids[0] !== input.targetPlaylistId) continue;
    return run.id;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
