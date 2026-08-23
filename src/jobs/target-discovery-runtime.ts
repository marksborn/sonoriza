import { AsyncLocalStorage } from "node:async_hooks";

import { prisma } from "@/lib/prisma";
import {
  normalizeTargetDiscoveryRuntimeTargets,
  resolveTargetDiscoveryRuntimePolicy,
  targetDiscoveryPolicyFingerprint,
  type TargetDiscoveryRuntimePolicyReason,
  type TargetDiscoveryRuntimeTarget,
} from "@/services/music-discovery/target-discovery-runtime-policy";
import type { TargetDiscoveryPolicy } from "@/services/music-discovery/target-discovery-policy";

export class TargetDiscoveryPolicyChangedError extends Error {
  readonly targetPlaylistIds: string[];

  constructor(targetPlaylistIds: string[]) {
    super(
      "A geração foi bloqueada antes de alterar o Spotify porque a configuração de Descobrir por destino mudou durante o planejamento. Simule novamente antes de publicar.",
    );
    this.name = "TargetDiscoveryPolicyChangedError";
    this.targetPlaylistIds = [...targetPlaylistIds];
  }
}

export type TargetDiscoveryRuntimeState = {
  enabled: boolean;
  reason: TargetDiscoveryRuntimePolicyReason;
  userId: string;
  userEmail: string | null;
  simulate: boolean;
  targetIds: string[];
  targetNames: Map<string, string>;
  policies: Map<string, TargetDiscoveryPolicy>;
  fingerprints: Map<string, string>;
  sourceProjectionApplied: boolean;
  externalAttempted: boolean;
  externalApplied: boolean;
  selectedExternalDiscoveryCount: number;
  preWriteRevalidated: boolean;
  changedTargetIds: string[];
  evidence: Record<string, unknown> | null;
};

const storage = new AsyncLocalStorage<TargetDiscoveryRuntimeState>();

export function createTargetDiscoveryRuntimeState(input: {
  userId: string;
  userEmail: string | null | undefined;
  simulate: boolean;
  baseDiscoveryEnabled: boolean;
  targets: TargetDiscoveryRuntimeTarget[];
}): TargetDiscoveryRuntimeState {
  const rollout = resolveTargetDiscoveryRuntimePolicy({
    baseDiscoveryEnabled: input.baseDiscoveryEnabled,
    userEmail: input.userEmail,
    masterEnabled: process.env.DISCOVER_DEST_RUNTIME_ENABLED,
    allowlistedEmails: process.env.DISCOVER_DEST_RUNTIME_USER_EMAILS,
  });
  const policies = normalizeTargetDiscoveryRuntimeTargets(input.targets);
  return {
    enabled: rollout.enabled,
    reason: rollout.reason,
    userId: input.userId,
    userEmail: normalizeEmail(input.userEmail),
    simulate: input.simulate,
    targetIds: input.targets.map((target) => target.targetPlaylistId),
    targetNames: new Map(
      input.targets.map((target) => [
        target.targetPlaylistId,
        target.targetName?.trim() || target.targetPlaylistId,
      ]),
    ),
    policies,
    fingerprints: new Map(
      [...policies].map(([targetId, policy]) => [
        targetId,
        targetDiscoveryPolicyFingerprint(policy),
      ]),
    ),
    sourceProjectionApplied: false,
    externalAttempted: false,
    externalApplied: false,
    selectedExternalDiscoveryCount: 0,
    preWriteRevalidated: false,
    changedTargetIds: [],
    evidence: null,
  };
}

export function runWithTargetDiscoveryRuntimeState<T>(
  state: TargetDiscoveryRuntimeState,
  run: () => Promise<T>,
): Promise<T> {
  return storage.run(state, run);
}

export function currentTargetDiscoveryRuntimeState(): TargetDiscoveryRuntimeState | null {
  return storage.getStore() ?? null;
}

export async function revalidateTargetDiscoveryPoliciesBeforeRealWrite(): Promise<void> {
  const state = currentTargetDiscoveryRuntimeState();
  if (!state?.enabled || state.simulate || state.targetIds.length === 0) return;

  const rows = await prisma.targetPlaylist.findMany({
    where: {
      userId: state.userId,
      id: { in: state.targetIds },
    },
    select: {
      id: true,
      enabled: true,
      discoveryEnabled: true,
      discoveryFamiliarEnabled: true,
      discoveryRediscoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryReleasesEnabled: true,
      discoveryIntensity: true,
    },
  });

  const liveById = new Map(rows.map((row) => [row.id, row] as const));
  const changed: string[] = [];

  for (const targetId of state.targetIds) {
    const row = liveById.get(targetId);
    if (!row || !row.enabled) {
      changed.push(targetId);
      continue;
    }
    const livePolicy = normalizeTargetDiscoveryRuntimeTargets([
      {
        targetPlaylistId: targetId,
        persistedPolicy: row,
      },
    ]).get(targetId)!;
    if (
      targetDiscoveryPolicyFingerprint(livePolicy) !==
      state.fingerprints.get(targetId)
    ) {
      changed.push(targetId);
    }
  }

  state.preWriteRevalidated = true;
  state.changedTargetIds = changed;
  if (changed.length > 0) throw new TargetDiscoveryPolicyChangedError(changed);
}

export function targetDiscoveryRuntimeSummary(
  state: TargetDiscoveryRuntimeState,
): Record<string, unknown> {
  return {
    version: "discover-dest-gate5-runtime-v1",
    enabled: state.enabled,
    reason: state.reason,
    userAllowlisted: state.reason === "ENABLED",
    sourceProjectionApplied: state.sourceProjectionApplied,
    externalAttempted: state.externalAttempted,
    externalApplied: state.externalApplied,
    selectedExternalDiscoveryCount: state.selectedExternalDiscoveryCount,
    preWriteRevalidated: state.preWriteRevalidated,
    changedTargetIds: state.changedTargetIds,
    targets: state.targetIds.map((targetPlaylistId) => {
      const policy = state.policies.get(targetPlaylistId);
      return {
        targetPlaylistId,
        targetName: state.targetNames.get(targetPlaylistId) ?? targetPlaylistId,
        enabled: policy?.enabled ?? false,
        familiarEnabled: policy?.familiarEnabled ?? false,
        rediscoveryEnabled: policy?.rediscoveryEnabled ?? false,
        discoveryEnabled: policy?.discoveryEnabled ?? false,
        releasesEnabled: policy?.releasesEnabled ?? false,
        intensity: policy?.intensity ?? "BALANCED",
      };
    }),
    evidence: state.evidence,
  };
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}
