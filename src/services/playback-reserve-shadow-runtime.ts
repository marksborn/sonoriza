import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  loadEffectivePlaybackReservePolicy,
  type EffectivePlaybackReservePolicySnapshot,
} from "@/services/playback-reserve-policy";
import type { PlaybackReserveRunShadowEvidence } from "@/services/playlist-planner/plan-run-playback-reserve";

export type PlaybackReserveRuntimeMode = "OFF" | "SHADOW" | "ACTIVE";
export type PlaybackReserveRuntimeStatus =
  | "OFF"
  | "READY_SHADOW"
  | "READY_ACTIVE_SIMULATION"
  | "READY_ACTIVE_REAL"
  | "ABSTAIN_ACTIVE_SCOPE_REQUIRED"
  | "ABSTAIN_TARGET_NOT_ALLOWED"
  | "ABSTAIN_REBUILD_DAILY_REQUIRED"
  | "ABSTAIN_SIMULATION_REQUIRED";
export type PlaybackReserveRolePersistenceStatus =
  | "NOT_APPLICABLE"
  | "PENDING"
  | "PERSISTED"
  | "FAILED";

export type PlaybackReserveShadowRuntimeState = {
  gate: 7;
  configuredMode: PlaybackReserveRuntimeMode;
  effectiveMode: PlaybackReserveRuntimeMode;
  simulate: boolean;
  plannerInfluence: boolean;
  spotifyWriteInfluence: boolean;
  additionalProviderReads: false;
  status: PlaybackReserveRuntimeStatus;
  targetPlaylistIds: readonly string[];
  allowedTargetIds: ReadonlySet<string>;
  policies: ReadonlyMap<string, EffectivePlaybackReservePolicySnapshot>;
  simulationApprovalKey: string | null;
  simulationApprovedRunId: string | null;
  rolePersistenceStatus: PlaybackReserveRolePersistenceStatus;
  reserveRoleCount: number;
  evidence: PlaybackReserveRunShadowEvidence | null;
};

const storage = new AsyncLocalStorage<PlaybackReserveShadowRuntimeState>();

export async function preparePlaybackReserveShadowRuntime(input: {
  userId: string;
  targetPlaylistIds?: readonly string[];
  simulate?: boolean;
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

  const base = {
    gate: 7 as const,
    configuredMode,
    simulate,
    additionalProviderReads: false as const,
    targetPlaylistIds,
    allowedTargetIds,
    policies: policyMap,
    reserveRoleCount: 0,
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
      simulationApprovalKey: approvalKey(targetPlaylistIds, policyMap),
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
  }

  if (targetPlaylistIds.length !== 1) {
    return {
      ...base,
      effectiveMode: "SHADOW",
      plannerInfluence: false,
      spotifyWriteInfluence: false,
      status: "ABSTAIN_ACTIVE_SCOPE_REQUIRED",
      simulationApprovalKey: approvalKey(targetPlaylistIds, policyMap),
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
  }

  const target = targets[0]!;
  const key = approvalKey(targetPlaylistIds, policyMap);

  if (!allowedTargetIds.has(target.id)) {
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

  if (target.updatePolicy !== "REBUILD_DAILY") {
    return {
      ...base,
      effectiveMode: "SHADOW",
      plannerInfluence: false,
      spotifyWriteInfluence: false,
      status: "ABSTAIN_REBUILD_DAILY_REQUIRED",
      simulationApprovalKey: key,
      simulationApprovedRunId: null,
      rolePersistenceStatus: "NOT_APPLICABLE",
    };
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

  const approvedRunId = await findApprovedGate7Simulation({
    userId: input.userId,
    targetPlaylistId: target.id,
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

export function recordPlaybackReserveRolePersistence(input: {
  status: "PERSISTED" | "FAILED";
  reserveRoleCount?: number;
}): void {
  const state = storage.getStore();
  if (!state) return;
  state.rolePersistenceStatus = input.status;
  if (typeof input.reserveRoleCount === "number") {
    state.reserveRoleCount = input.reserveRoleCount;
  }
}

export function playbackReserveShadowRuntimeSummary(
  state: PlaybackReserveShadowRuntimeState,
) {
  return {
    gate: 7 as const,
    configuredMode: state.configuredMode,
    effectiveMode: state.effectiveMode,
    simulate: state.simulate,
    plannerInfluence: state.plannerInfluence,
    spotifyWriteInfluence: state.spotifyWriteInfluence,
    additionalProviderReads: false as const,
    status: state.status,
    targetPlaylistIds: [...state.targetPlaylistIds],
    allowedTargetIds: [...state.allowedTargetIds].sort(),
    simulationApprovalKey: state.simulationApprovalKey,
    simulationApprovedRunId: state.simulationApprovedRunId,
    rolePersistenceStatus: state.rolePersistenceStatus,
    reserveRoleCount: state.reserveRoleCount,
    evidence: state.evidence,
  };
}

export function playbackReserveRuntimeApprovalKey(input: {
  targetPlaylistIds: readonly string[];
  policies: ReadonlyMap<string, EffectivePlaybackReservePolicySnapshot>;
}): string {
  return approvalKey(input.targetPlaylistIds, input.policies);
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

function approvalKey(
  targetPlaylistIds: readonly string[],
  policies: ReadonlyMap<string, EffectivePlaybackReservePolicySnapshot>,
): string {
  const payload = [...targetPlaylistIds]
    .sort()
    .map((targetPlaylistId) => ({
      targetPlaylistId,
      policy: policies.get(targetPlaylistId) ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function findApprovedGate7Simulation(input: {
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
    take: 20,
    select: { id: true, summary: true },
  });

  for (const run of runs) {
    const summary = asRecord(run.summary);
    const runtime = asRecord(summary?.playbackReserveRuntime);
    if (!runtime) continue;
    if (runtime.gate !== 7) continue;
    if (runtime.effectiveMode !== "ACTIVE") continue;
    if (runtime.simulate !== true) continue;
    if (runtime.status !== "READY_ACTIVE_SIMULATION") continue;
    if (runtime.rolePersistenceStatus !== "PERSISTED") continue;
    if (runtime.simulationApprovalKey !== input.approvalKey) continue;
    const ids = Array.isArray(runtime.targetPlaylistIds)
      ? runtime.targetPlaylistIds.filter((value): value is string => typeof value === "string")
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
