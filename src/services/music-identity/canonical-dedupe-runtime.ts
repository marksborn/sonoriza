import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import type { Candidate, PlanResult } from "@/services/playlist-planner/types";

export const GATE4E1_POLICY = "LEGACY_FIRST_OCCURRENCE_V1" as const;
export const GATE4E1_RUNTIME_VERSION = "music-identity-gate4e1-runtime-v1" as const;

export type Gate4E1Mode = "OFF" | "ACTIVE";

export type Gate4E1ActivationReason =
  | "MODE_OFF"
  | "ACTIVE_ALLOWED"
  | "ACTIVE_NO_ALLOWED_TARGET"
  | "INVALID_MODE"
  | "PREPARATION_ERROR";

export type Gate4E1TargetStatus =
  | "NOT_ALLOWLISTED"
  | "TARGET_UNAVAILABLE"
  | "PROJECTION_NOT_READY"
  | "MULTIPLE_READY_PROJECTIONS"
  | "SNAPSHOT_INVALID"
  | "SNAPSHOT_MISMATCH"
  | "SOURCE_SCOPE_MISMATCH"
  | "PROJECTION_INVALID"
  | "READY";

export type Gate4E1ComponentActivationAbstentionReason =
  | "MEMBER_NOT_PRESENT_IN_CURRENT_SOURCE_SCOPE"
  | "REPRESENTATIVE_ORDER_CHANGED";

export type Gate4E1Component = Readonly<{
  componentId: string;
  memberProviderTrackIds: readonly string[];
  representativeProviderTrackId: string;
  preferenceState: string;
  preferenceCompatible: boolean;
  containsExcludedPreference: boolean;
  activationCompatible?: boolean;
  activationAbstentionReason?: Gate4E1ComponentActivationAbstentionReason | null;
}>;

export type Gate4E1OrderedOccurrence = Readonly<{
  sourcePlaylistId: string;
  sourceOrder: number;
  cachePosition: number;
  providerTrackId: string;
}>;

export type Gate4E1TargetActivation = Readonly<{
  targetPlaylistId: string;
  status: Gate4E1TargetStatus;
  reason: string | null;
  projectionId: string | null;
  projectionVersion: number | null;
  projectionFingerprint: string | null;
  components: readonly Gate4E1Component[];
}>;

export type Gate4E1PlannerComparison = Readonly<{
  legacyItemCount: number;
  canonicalItemCount: number;
  itemCountDelta: number;
  legacyDurationMs: number;
  canonicalDurationMs: number;
  durationDeltaMs: number;
  legacyCompositionQualityPassed: boolean;
  canonicalCompositionQualityPassed: boolean;
  legacyPoolExhausted: boolean;
  canonicalPoolExhausted: boolean;
  legacyOrderFingerprint: string;
  canonicalOrderFingerprint: string;
  orderChanged: boolean;
}>;

export type Gate4E1TargetEvidence = {
  targetPlaylistId: string;
  status: Gate4E1TargetStatus;
  plannerInfluence: boolean;
  legacyCandidateCount: number;
  canonicalCandidateCount: number;
  aliasesCollapsed: number;
  componentsApplied: number;
  representativesKept: string[];
  droppedAliases: string[];
  componentAbstentions: Array<{
    componentId: string;
    reason: string;
  }>;
  plannerComparison: Gate4E1PlannerComparison | null;
};

export type Gate4E1RuntimeState = {
  runtimeVersion: typeof GATE4E1_RUNTIME_VERSION;
  userId: string;
  requestedMode: Gate4E1Mode;
  effectiveMode: Gate4E1Mode;
  activationReason: Gate4E1ActivationReason;
  allowlistedTargetIds: ReadonlySet<string>;
  targets: ReadonlyMap<string, Gate4E1TargetActivation>;
  evidenceByTargetId: Map<string, Gate4E1TargetEvidence>;
  databaseReads: boolean;
  providerCalls: false;
  databaseWrites: false;
  identityWrites: false;
  canonicalWrites: false;
  providerRefReassociation: false;
  spotifyWrites: false;
};

export type Gate4E1ModeResolution = Readonly<{
  requestedMode: Gate4E1Mode;
  effectiveMode: Gate4E1Mode;
  activationReason: Gate4E1ActivationReason;
}>;

const storage = new AsyncLocalStorage<Gate4E1RuntimeState>();

export function resolveGate4E1Mode(input: {
  requestedMode?: string | null;
  userId: string;
  allowlist?: string | null;
  targetPlaylistIds?: readonly string[] | null;
}): Gate4E1ModeResolution & { allowlistedTargetIds: Set<string> } {
  const rawMode = clean(input.requestedMode)?.toUpperCase() ?? "OFF";
  if (rawMode !== "OFF" && rawMode !== "ACTIVE") {
    return {
      requestedMode: "OFF",
      effectiveMode: "OFF",
      activationReason: "INVALID_MODE",
      allowlistedTargetIds: new Set<string>(),
    };
  }

  const requestedMode = rawMode as Gate4E1Mode;
  if (requestedMode === "OFF") {
    return {
      requestedMode,
      effectiveMode: "OFF",
      activationReason: "MODE_OFF",
      allowlistedTargetIds: new Set<string>(),
    };
  }

  const requestedTargetIds = input.targetPlaylistIds
    ? new Set(input.targetPlaylistIds.map(clean).filter((value): value is string => Boolean(value)))
    : null;
  const allowlistedTargetIds = new Set<string>();
  for (const entry of parseAllowlist(input.allowlist)) {
    if (entry.userId !== input.userId) continue;
    if (requestedTargetIds && !requestedTargetIds.has(entry.targetPlaylistId)) continue;
    allowlistedTargetIds.add(entry.targetPlaylistId);
  }

  return {
    requestedMode,
    effectiveMode: allowlistedTargetIds.size > 0 ? "ACTIVE" : "OFF",
    activationReason:
      allowlistedTargetIds.size > 0 ? "ACTIVE_ALLOWED" : "ACTIVE_NO_ALLOWED_TARGET",
    allowlistedTargetIds,
  };
}

export function createGate4E1RuntimeState(input: {
  userId: string;
  mode: Gate4E1ModeResolution;
  allowlistedTargetIds?: ReadonlySet<string>;
  targets?: ReadonlyMap<string, Gate4E1TargetActivation>;
  databaseReads?: boolean;
  activationReason?: Gate4E1ActivationReason;
}): Gate4E1RuntimeState {
  return {
    runtimeVersion: GATE4E1_RUNTIME_VERSION,
    userId: input.userId,
    requestedMode: input.mode.requestedMode,
    effectiveMode:
      input.activationReason === "PREPARATION_ERROR" ? "OFF" : input.mode.effectiveMode,
    activationReason: input.activationReason ?? input.mode.activationReason,
    allowlistedTargetIds: input.allowlistedTargetIds ?? new Set<string>(),
    targets: input.targets ?? new Map<string, Gate4E1TargetActivation>(),
    evidenceByTargetId: new Map<string, Gate4E1TargetEvidence>(),
    databaseReads: input.databaseReads ?? false,
    providerCalls: false,
    databaseWrites: false,
    identityWrites: false,
    canonicalWrites: false,
    providerRefReassociation: false,
    spotifyWrites: false,
  };
}

export function runWithGate4E1RuntimeState<T>(
  state: Gate4E1RuntimeState,
  callback: () => T,
): T {
  return storage.run(state, callback);
}

export function currentGate4E1RuntimeState(): Gate4E1RuntimeState | undefined {
  return storage.getStore();
}

/**
 * Applies the persisted representative policy to the current DB-only ordering
 * evidence. Operational cache refreshes do not participate in this check; only
 * the first ordered occurrence of each projected member matters.
 */
export function applyGate4E1ActivationCompatibility(input: {
  components: readonly Gate4E1Component[];
  occurrences: readonly Gate4E1OrderedOccurrence[];
}): Gate4E1Component[] {
  return input.components.map((component) => {
    const members = [...new Set(component.memberProviderTrackIds.map(clean).filter(
      (value): value is string => Boolean(value),
    ))].sort();
    const representative = clean(component.representativeProviderTrackId);

    if (members.length < 2 || !representative || !members.includes(representative)) {
      return { ...component, activationCompatible: false, activationAbstentionReason: "MEMBER_NOT_PRESENT_IN_CURRENT_SOURCE_SCOPE" };
    }

    const firstOccurrences: Gate4E1OrderedOccurrence[] = [];
    for (const member of members) {
      const first = input.occurrences
        .filter((occurrence) => occurrence.providerTrackId === member)
        .sort(compareOccurrence)[0];
      if (!first) {
        return {
          ...component,
          activationCompatible: false,
          activationAbstentionReason: "MEMBER_NOT_PRESENT_IN_CURRENT_SOURCE_SCOPE",
        };
      }
      firstOccurrences.push(first);
    }

    firstOccurrences.sort(compareOccurrence);
    if (firstOccurrences[0]!.providerTrackId !== representative) {
      return {
        ...component,
        activationCompatible: false,
        activationAbstentionReason: "REPRESENTATIVE_ORDER_CHANGED",
      };
    }

    return {
      ...component,
      activationCompatible: true,
      activationAbstentionReason: null,
    };
  });
}

/**
 * Productive seam for Gate 4E1. It is deliberately pure/in-memory: no Prisma,
 * provider client, resolver or projection builder is reachable from this file.
 * OFF/abstention returns the exact candidate sequence it received.
 */
export function applyGate4E1CanonicalDedupeToMusicCandidates(input: {
  targetPlaylistId: string;
  candidates: readonly Candidate[];
}): Candidate[] {
  const state = currentGate4E1RuntimeState();
  if (!state || state.effectiveMode !== "ACTIVE") return [...input.candidates];

  const activation = state.targets.get(input.targetPlaylistId);
  if (!activation || activation.status !== "READY") {
    if (activation) {
      state.evidenceByTargetId.set(
        input.targetPlaylistId,
        emptyTargetEvidence(input.targetPlaylistId, activation.status, input.candidates.length),
      );
    }
    return [...input.candidates];
  }

  const projected = projectGate4E1Candidates({
    candidates: input.candidates,
    components: activation.components,
  });
  state.evidenceByTargetId.set(input.targetPlaylistId, {
    targetPlaylistId: input.targetPlaylistId,
    status: activation.status,
    plannerInfluence: projected.aliasesCollapsed > 0,
    legacyCandidateCount: input.candidates.length,
    canonicalCandidateCount: projected.candidates.length,
    aliasesCollapsed: projected.aliasesCollapsed,
    componentsApplied: projected.componentsApplied,
    representativesKept: projected.representativesKept,
    droppedAliases: projected.droppedAliases,
    componentAbstentions: projected.componentAbstentions,
    plannerComparison: null,
  });
  return projected.candidates;
}

export function gate4E1PlannerInfluencedTarget(targetPlaylistId: string): boolean {
  return currentGate4E1RuntimeState()?.evidenceByTargetId.get(targetPlaylistId)?.plannerInfluence === true;
}

export function captureGate4E1PlannerComparison(input: {
  targetPlaylistId: string;
  legacy: PlanResult;
  canonical: PlanResult;
}): void {
  const state = currentGate4E1RuntimeState();
  const evidence = state?.evidenceByTargetId.get(input.targetPlaylistId);
  if (!evidence?.plannerInfluence) return;

  const legacyOrderFingerprint = orderFingerprint(input.legacy.items);
  const canonicalOrderFingerprint = orderFingerprint(input.canonical.items);
  evidence.plannerComparison = {
    legacyItemCount: input.legacy.items.length,
    canonicalItemCount: input.canonical.items.length,
    itemCountDelta: input.canonical.items.length - input.legacy.items.length,
    legacyDurationMs: input.legacy.stats.totalDurationMs,
    canonicalDurationMs: input.canonical.stats.totalDurationMs,
    durationDeltaMs:
      input.canonical.stats.totalDurationMs - input.legacy.stats.totalDurationMs,
    legacyCompositionQualityPassed: input.legacy.stats.compositionQualityPassed,
    canonicalCompositionQualityPassed: input.canonical.stats.compositionQualityPassed,
    legacyPoolExhausted: input.legacy.stats.poolExhausted,
    canonicalPoolExhausted: input.canonical.stats.poolExhausted,
    legacyOrderFingerprint,
    canonicalOrderFingerprint,
    orderChanged: legacyOrderFingerprint !== canonicalOrderFingerprint,
  };
}

export function gate4E1RuntimeSummary(state: Gate4E1RuntimeState): Record<string, unknown> {
  return {
    runtimeVersion: state.runtimeVersion,
    policy: GATE4E1_POLICY,
    requestedMode: state.requestedMode,
    effectiveMode: state.effectiveMode,
    activationReason: state.activationReason,
    plannerInfluence: [...state.evidenceByTargetId.values()].some(
      (entry) => entry.plannerInfluence,
    ),
    databaseReads: state.databaseReads,
    providerCalls: state.providerCalls,
    databaseWrites: state.databaseWrites,
    identityWrites: state.identityWrites,
    canonicalWrites: state.canonicalWrites,
    providerRefReassociation: state.providerRefReassociation,
    spotifyWrites: state.spotifyWrites,
    allowlistedTargetIds: [...state.allowlistedTargetIds].sort(),
    targets: [...state.targets.values()]
      .map((target) => ({
        targetPlaylistId: target.targetPlaylistId,
        status: target.status,
        reason: target.reason,
        projectionId: target.projectionId,
        projectionVersion: target.projectionVersion,
        projectionFingerprint: target.projectionFingerprint,
        componentCount: target.components.length,
        evidence: state.evidenceByTargetId.get(target.targetPlaylistId) ?? null,
      }))
      .sort((a, b) => a.targetPlaylistId.localeCompare(b.targetPlaylistId)),
  };
}

export function projectGate4E1Candidates(input: {
  candidates: readonly Candidate[];
  components: readonly Gate4E1Component[];
}): {
  candidates: Candidate[];
  aliasesCollapsed: number;
  componentsApplied: number;
  representativesKept: string[];
  droppedAliases: string[];
  componentAbstentions: Array<{ componentId: string; reason: string }>;
} {
  const candidatesByTrackId = new Map<string, Candidate[]>();
  for (const candidate of input.candidates) {
    const trackId = clean(candidate.spotifyTrackId);
    if (!trackId) continue;
    const rows = candidatesByTrackId.get(trackId) ?? [];
    rows.push(candidate);
    candidatesByTrackId.set(trackId, rows);
  }

  const droppedTrackIds = new Set<string>();
  const representativesKept: string[] = [];
  const droppedAliases: string[] = [];
  const componentAbstentions: Array<{ componentId: string; reason: string }> = [];
  let componentsApplied = 0;

  for (const component of input.components) {
    const members = [...new Set(component.memberProviderTrackIds.map(clean).filter(
      (value): value is string => Boolean(value),
    ))].sort();
    const representative = clean(component.representativeProviderTrackId);
    if (members.length < 2 || !representative || !members.includes(representative)) {
      componentAbstentions.push({ componentId: component.componentId, reason: "INVALID_COMPONENT" });
      continue;
    }
    if (component.activationCompatible === false) {
      componentAbstentions.push({
        componentId: component.componentId,
        reason: component.activationAbstentionReason ?? "ACTIVATION_COMPATIBILITY_CHANGED",
      });
      continue;
    }
    if (!component.preferenceCompatible || component.containsExcludedPreference) {
      componentAbstentions.push({ componentId: component.componentId, reason: "PREFERENCE_INCOMPATIBLE" });
      continue;
    }

    const presentMembers = members.filter((member) => (candidatesByTrackId.get(member)?.length ?? 0) > 0);
    if (presentMembers.length !== members.length) {
      componentAbstentions.push({
        componentId: component.componentId,
        reason: "INPUT_CARDINALITY_OR_MEMBERSHIP_CHANGED",
      });
      continue;
    }

    const cardinalityValid = members.every(
      (member) => (candidatesByTrackId.get(member)?.length ?? 0) === 1,
    );
    if (!cardinalityValid) {
      componentAbstentions.push({
        componentId: component.componentId,
        reason: "INPUT_CARDINALITY_OR_MEMBERSHIP_CHANGED",
      });
      continue;
    }

    componentsApplied += 1;
    representativesKept.push(representative);
    for (const member of members) {
      if (member === representative) continue;
      droppedTrackIds.add(member);
      droppedAliases.push(member);
    }
  }

  const candidates = input.candidates.filter((candidate) => {
    const trackId = clean(candidate.spotifyTrackId);
    return !trackId || !droppedTrackIds.has(trackId);
  });
  return {
    candidates,
    aliasesCollapsed: input.candidates.length - candidates.length,
    componentsApplied,
    representativesKept: [...new Set(representativesKept)].sort(),
    droppedAliases: [...new Set(droppedAliases)].sort(),
    componentAbstentions,
  };
}

function compareOccurrence(a: Gate4E1OrderedOccurrence, b: Gate4E1OrderedOccurrence): number {
  return (
    a.sourceOrder - b.sourceOrder ||
    a.cachePosition - b.cachePosition ||
    a.providerTrackId.localeCompare(b.providerTrackId)
  );
}

function parseAllowlist(value: string | null | undefined): Array<{
  userId: string;
  targetPlaylistId: string;
}> {
  const result: Array<{ userId: string; targetPlaylistId: string }> = [];
  for (const raw of (value ?? "").split(/[,;\s]+/)) {
    const entry = clean(raw);
    if (!entry) continue;
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) continue;
    const userId = clean(entry.slice(0, separator));
    const targetPlaylistId = clean(entry.slice(separator + 1));
    if (userId && targetPlaylistId) result.push({ userId, targetPlaylistId });
  }
  return result;
}

function emptyTargetEvidence(
  targetPlaylistId: string,
  status: Gate4E1TargetStatus,
  candidateCount: number,
): Gate4E1TargetEvidence {
  return {
    targetPlaylistId,
    status,
    plannerInfluence: false,
    legacyCandidateCount: candidateCount,
    canonicalCandidateCount: candidateCount,
    aliasesCollapsed: 0,
    componentsApplied: 0,
    representativesKept: [],
    droppedAliases: [],
    componentAbstentions: [],
    plannerComparison: null,
  };
}

function orderFingerprint(items: readonly Candidate[]): string {
  return createHash("sha256")
    .update(JSON.stringify(items.map((item) => item.uri)))
    .digest("hex");
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
