import { AsyncLocalStorage } from "node:async_hooks";

import { getCompleteMusicDiscoveryProfile } from "@/services/music-discovery/complete-profile";
import { resolveRuntimeExternalDiscovery } from "@/services/music-discovery/external-discovery-runtime";
import {
  applyDiscoveryGate5H,
  resolveDiscoveryGate5HPolicy,
  type DiscoveryGate5HPolicyReason,
} from "@/services/music-discovery/planner-discovery-gate5h";
import type { DiscoveryPlannerPoolEntry } from "@/services/music-discovery/planner-bridge";
import {
  buildCompleteDiscoveryMusicSelection,
  collectCompleteDiscoverySourceUniverse,
  type DiscoveryPreviewSource,
} from "@/services/music-discovery/planner-preview";
import {
  targetDiscoveryRuntimeCaps,
  targetUsesExternalDiscovery,
} from "@/services/music-discovery/target-discovery-runtime-policy";
import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";
import type {
  Candidate,
  PlanRunResult,
  RunTarget,
} from "@/services/playlist-planner";

import {
  currentMusicRepeatState,
  filterMusicBatchForCurrentRun,
  revalidateMusicRepeatBeforeRealWrite,
} from "./music-repeat-runtime";
import { currentTargetDiscoveryRuntimeState } from "./target-discovery-runtime";

export const DISCOVERY_GATE4A_POLICY_VERSION = "gate4a-runtime-v1";
export const DISCOVERY_GATE4A_SEQUENCE_TERMINAL_UNDERFILL_TOLERANCE_MS = 30_000;
export const DISCOVERY_GATE4A_DEFAULT_REDISCOVERY_CEILING = 0.25;

export type DiscoveryRuntimePolicyReason =
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "ENABLED";

export type DiscoveryGate5HRuntimeState = {
  enabled: boolean;
  reason: DiscoveryGate5HPolicyReason;
  attempted: boolean;
  applied: boolean;
  invariantsPassed: boolean | null;
  selectedDiscoveryCount: number;
  failure: string | null;
  evidence: Record<string, unknown> | null;
};

export type DiscoveryRuntimeState = {
  policyVersion: typeof DISCOVERY_GATE4A_POLICY_VERSION;
  enabled: boolean;
  reason: DiscoveryRuntimePolicyReason;
  userId: string;
  userEmail: string | null;
  asOf: Date;
  rediscoveryCeiling: number;
  applied: boolean;
  evidence: Record<string, unknown> | null;
  failure: string | null;
  gate5h: DiscoveryGate5HRuntimeState;
};

type RuntimeSource = DiscoveryPreviewSource;

type DiscoveryMemoryCheckpoint = {
  phase: string;
  rssMiB: number;
  heapUsedMiB: number;
  heapTotalMiB: number;
  externalMiB: number;
  arrayBuffersMiB: number;
};

const storage = new AsyncLocalStorage<DiscoveryRuntimeState>();

export function resolveDiscoveryGate4APolicy(input: {
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  rediscoveryCeiling?: string | null;
}) {
  const email = normalizeEmail(input.userEmail);
  const masterEnabled = parseBoolean(input.masterEnabled);
  const rediscoveryCeiling = parseRediscoveryCeiling(input.rediscoveryCeiling);

  if (!masterEnabled) {
    return {
      enabled: false,
      reason: "MASTER_DISABLED" as const,
      rediscoveryCeiling,
    };
  }
  if (!email) {
    return {
      enabled: false,
      reason: "USER_EMAIL_MISSING" as const,
      rediscoveryCeiling,
    };
  }

  const allowlist = new Set(
    String(input.allowlistedEmails ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value): value is string => Boolean(value)),
  );
  if (!allowlist.has(email)) {
    return {
      enabled: false,
      reason: "USER_NOT_ALLOWLISTED" as const,
      rediscoveryCeiling,
    };
  }

  return {
    enabled: true,
    reason: "ENABLED" as const,
    rediscoveryCeiling,
  };
}

export function createDiscoveryGate4ARunState(input: {
  userId: string;
  userEmail: string | null | undefined;
  asOf: Date;
}): DiscoveryRuntimeState {
  const policy = resolveDiscoveryGate4APolicy({
    userEmail: input.userEmail,
    masterEnabled: process.env.DISCOVERY_RUNTIME_ENABLED,
    allowlistedEmails: process.env.DISCOVERY_RUNTIME_USER_EMAILS,
    rediscoveryCeiling: process.env.DISCOVERY_RUNTIME_REDISCOVERY_CEILING,
  });
  const gate5hPolicy = resolveDiscoveryGate5HPolicy({
    baseDiscoveryEnabled: policy.enabled,
    userEmail: input.userEmail,
    masterEnabled: process.env.DISCOVERY_GATE5H_ENABLED,
    allowlistedEmails: process.env.DISCOVERY_GATE5H_USER_EMAILS,
  });
  return {
    policyVersion: DISCOVERY_GATE4A_POLICY_VERSION,
    enabled: policy.enabled,
    reason: policy.reason,
    userId: input.userId,
    userEmail: normalizeEmail(input.userEmail),
    asOf: input.asOf,
    rediscoveryCeiling: policy.rediscoveryCeiling,
    applied: false,
    evidence: null,
    failure: null,
    gate5h: {
      enabled: gate5hPolicy.enabled,
      reason: gate5hPolicy.reason,
      attempted: false,
      applied: false,
      invariantsPassed: null,
      selectedDiscoveryCount: 0,
      failure: null,
      evidence: null,
    },
  };
}

export function runWithDiscoveryRuntimeState<T>(
  state: DiscoveryRuntimeState,
  run: () => Promise<T>,
): Promise<T> {
  return storage.run(state, run);
}

export function currentDiscoveryRuntimeState(): DiscoveryRuntimeState | null {
  return storage.getStore() ?? null;
}

export async function prepareDiscoveryMusicForCurrentRun<
  TSource extends RuntimeSource,
>(
  sources: TSource[],
  options: {
    recoverSourceFailure?: (source: TSource, error: unknown) => boolean;
  } = {},
): Promise<{
  rankedMusic: Candidate[];
  sourceEntries: DiscoveryPlannerPoolEntry[];
  podcastSources: TSource[];
  completedMusicSourceIds: string[];
  degradedFailures: Array<{ source: TSource; error: unknown }>;
} | null> {
  const state = currentDiscoveryRuntimeState();
  if (!state?.enabled) return null;

  const memoryCheckpoints: DiscoveryMemoryCheckpoint[] = [];
  const checkpoint = (phase: string) => {
    const sample = discoveryMemoryCheckpoint(phase);
    memoryCheckpoints.push(sample);
    console.info("[DISCOVERY-01][memory]", JSON.stringify(sample));
  };

  try {
    const musicSources = sources.filter((source) => source.kind === "MUSIC");
    const podcastSources = sources.filter((source) => source.kind === "PODCAST");

    checkpoint("start");
    const profile = await getCompleteMusicDiscoveryProfile(state.userId, {
      asOf: state.asOf,
    });
    checkpoint("after-profile");
    const trackIdentities = await getDiscoveryTrackIdentityEvidence(state.userId);
    checkpoint("after-identities");
    const sourceUniverse = await collectCompleteDiscoverySourceUniverse(musicSources, options);
    checkpoint("after-source-universe");

    const repeatFiltered = filterMusicBatchForCurrentRun(sourceUniverse.music);
    const cooldownByTrackId = new Map(
      profile.tracks.map((track) => [track.spotifyTrackId, track.cooldownEligible] as const),
    );
    let reconciledTimelineBlockedCount = 0;
    const safeMusic = repeatFiltered.candidates.filter((candidate) => {
      const trackId = candidate.spotifyTrackId;
      if (!trackId) return true;
      const eligible = cooldownByTrackId.get(trackId);
      if (eligible === false || eligible === null) {
        reconciledTimelineBlockedCount += 1;
        return false;
      }
      return true;
    });
    checkpoint("after-music01-reconciliation");

    const selection = buildCompleteDiscoveryMusicSelection({
      profile,
      sourceUniverse: {
        ...sourceUniverse,
        music: safeMusic,
      },
      trackIdentities,
      rediscoveryCeiling: state.rediscoveryCeiling,
    });
    checkpoint("after-scoring-ranking");

    state.applied = true;
    state.evidence = {
      candidateUniverse: selection.scoring.selectionPolicy.candidateUniverse,
      selectionReady: selection.scoring.selectionPolicy.selectionReady,
      historyArtistCount: profile.artists.length,
      historyTrackCount: profile.tracks.length,
      musicSourceCount: sourceUniverse.evidence.musicSourceCount,
      musicSourceReadCalls: sourceUniverse.evidence.readCalls,
      degradedMusicSourceCount: sourceUniverse.evidence.degradedSourceCount,
      degradedMusicSources: sourceUniverse.evidence.degradedSources,
      sourceMusicBeforeMusic01: sourceUniverse.music.length,
      sourceMusicAfterMusic01: repeatFiltered.candidates.length,
      sourceMusicAfterCooldownReconciliation: safeMusic.length,
      reconciledTimelineBlockedCount,
      rankedMusicCount: selection.plannerPool.music.length,
      duplicateRecordingDroppedCount:
        selection.plannerPool.evidence.duplicateRecordingDroppedCount,
      rediscoveryCount: selection.plannerPool.evidence.rediscoveryCount,
      familiarCount: selection.plannerPool.evidence.familiarCount,
      sourceFallbackCount: selection.plannerPool.evidence.sourceFallbackCount,
      crossReleaseMatchedCount: selection.plannerPool.evidence.crossReleaseMatchedCount,
      rediscoveryCeiling: selection.plannerPool.evidence.rediscoveryCeiling,
      rediscoveryCeilingRelaxedCount:
        selection.plannerPool.evidence.rediscoveryCeilingRelaxedCount,
      replanAfterEachSourceRead: true,
      sequenceTerminalUnderfillToleranceMs:
        DISCOVERY_GATE4A_SEQUENCE_TERMINAL_UNDERFILL_TOLERANCE_MS,
      memoryCheckpoints,
    };

    return {
      rankedMusic: selection.plannerPool.music,
      sourceEntries: selection.plannerPool.entries,
      podcastSources,
      completedMusicSourceIds: sourceUniverse.evidence.sources.map((source) => source.id),
      degradedFailures: sourceUniverse.degradedFailures,
    };
  } catch (error) {
    state.failure = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export async function applyDiscoveryGate5HForCurrentRun(input: {
  plan: PlanRunResult;
  targets: RunTarget[];
  blockedMusicTrackIdsByTargetId?: ReadonlyMap<string, ReadonlySet<string>>;
  keepFilledTargetIds?: ReadonlySet<string>;
}): Promise<PlanRunResult> {
  const state = currentDiscoveryRuntimeState();
  if (!state?.gate5h.enabled) return input.plan;

  const targetRuntime = currentTargetDiscoveryRuntimeState();
  const targetScoped = targetRuntime?.enabled === true;
  const eligibleTargetIds = targetScoped
    ? new Set(
        input.plan.targets
          .filter((target) => {
            const policy = targetRuntime.policies.get(target.targetPlaylistId);
            return Boolean(
              policy &&
                targetUsesExternalDiscovery(policy) &&
                !input.keepFilledTargetIds?.has(target.targetPlaylistId) &&
                target.result.items.filter((item) => item.type === "MUSIC").length >= 5,
            );
          })
          .map((target) => target.targetPlaylistId),
      )
    : null;

  if (targetScoped) {
    // This also guarantees that the generator's existing final revalidation
    // runs before Spotify writes, even when every target abstains externally.
    state.gate5h.attempted = true;
    targetRuntime.externalAttempted = true;
    if (eligibleTargetIds!.size === 0) {
      state.gate5h.invariantsPassed = true;
      state.gate5h.evidence = {
        mode: "PER_TARGET",
        skipped: "TARGET_POLICY_NO_EXTERNAL_DISCOVERY",
        eligibleTargetIds: [],
      };
      targetRuntime.evidence = mergeEvidence(targetRuntime.evidence, {
        external: { skipped: "TARGET_POLICY_NO_EXTERNAL_DISCOVERY" },
      });
      return input.plan;
    }
  } else {
    const hasEligibleMusicTarget = input.plan.targets.some(
      (target) =>
        !input.keepFilledTargetIds?.has(target.targetPlaylistId) &&
        target.result.items.filter((item) => item.type === "MUSIC").length >= 5,
    );
    if (!hasEligibleMusicTarget) {
      state.gate5h.evidence = { skipped: "NO_ELIGIBLE_MUSIC_TARGET" };
      state.gate5h.invariantsPassed = true;
      return input.plan;
    }
    state.gate5h.attempted = true;
  }

  let external;
  try {
    external = await resolveRuntimeExternalDiscovery({
      userId: state.userId,
      asOf: state.asOf,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.gate5h.failure = `ACQUISITION_FAILED_ABSTAIN: ${message}`;
    state.gate5h.invariantsPassed = true;
    state.gate5h.evidence = {
      abstained: "ACQUISITION_ERROR",
      error: message,
    };
    if (targetRuntime?.enabled) {
      targetRuntime.evidence = mergeEvidence(targetRuntime.evidence, {
        external: { abstained: "ACQUISITION_ERROR", error: message },
      });
    }
    return input.plan;
  }

  const providerFailureCount =
    external.evidence.lastFmFailures +
    external.evidence.spotifyFailures +
    external.evidence.providerFailureCount;
  if (providerFailureCount > 0) {
    state.gate5h.failure = "PROVIDER_FAILURE_ABSTAIN";
    state.gate5h.invariantsPassed = true;
    state.gate5h.evidence = {
      acquisition: external.evidence,
      abstained: "PROVIDER_FAILURE",
    };
    if (targetRuntime?.enabled) {
      targetRuntime.evidence = mergeEvidence(targetRuntime.evidence, {
        external: { abstained: "PROVIDER_FAILURE" },
      });
    }
    return input.plan;
  }

  if (external.discoveries.length === 0) {
    state.gate5h.invariantsPassed = true;
    state.gate5h.evidence = {
      acquisition: external.evidence,
      abstained: "NO_RESOLVED_DISCOVERY",
    };
    if (targetRuntime?.enabled) {
      targetRuntime.evidence = mergeEvidence(targetRuntime.evidence, {
        external: { abstained: "NO_RESOLVED_DISCOVERY" },
      });
    }
    return input.plan;
  }

  // External acquisition introduces a real-time gap after the collector's
  // original MUSIC-01 pre-write check. This safety check now also revalidates
  // DISCOVER-DEST-01 policy through the independent target runtime context.
  await revalidateMusicRepeatBeforeRealWrite(input.plan);
  const repeatState = currentMusicRepeatState();
  const globalBlocked = repeatState?.context.blockedTrackIds ?? new Set<string>();
  const blockedByTarget = new Map<string, ReadonlySet<string>>();
  for (const target of input.targets) {
    const targetBlocked = input.blockedMusicTrackIdsByTargetId?.get(
      target.targetPlaylistId,
    );
    blockedByTarget.set(
      target.targetPlaylistId,
      new Set([...(targetBlocked ?? []), ...globalBlocked]),
    );
  }

  try {
    if (targetScoped && targetRuntime) {
      const applied = applyTargetScopedExternalDiscovery({
        baseline: input.plan,
        targets: input.targets,
        discoveries: external.discoveries,
        blockedMusicTrackIdsByTargetId: blockedByTarget,
        eligibleTargetIds: eligibleTargetIds!,
        targetRuntime,
      });
      state.gate5h.applied = applied.applied;
      state.gate5h.invariantsPassed = applied.invariantsPassed;
      state.gate5h.selectedDiscoveryCount = applied.selectedDiscoveryCount;
      state.gate5h.evidence = {
        acquisition: external.evidence,
        mode: "PER_TARGET",
        eligibleTargetIds: [...eligibleTargetIds!],
        selectedDiscoveryCount: applied.selectedDiscoveryCount,
        targets: applied.targetEvidence,
        replacements: applied.replacements,
      };
      targetRuntime.externalApplied = applied.applied;
      targetRuntime.selectedExternalDiscoveryCount = applied.selectedDiscoveryCount;
      targetRuntime.evidence = mergeEvidence(targetRuntime.evidence, {
        external: {
          eligibleTargetIds: [...eligibleTargetIds!],
          selectedDiscoveryCount: applied.selectedDiscoveryCount,
          replacements: applied.replacements,
        },
      });
      if (!applied.invariantsPassed) {
        state.gate5h.failure = "SURGICAL_INVARIANT_FAILED_ABSTAIN";
        return input.plan;
      }
      return applied.plan;
    }

    const applied = applyDiscoveryGate5H({
      baseline: input.plan,
      targets: input.targets,
      discoveries: external.discoveries,
      blockedMusicTrackIdsByTargetId: blockedByTarget,
      keepFilledTargetIds: input.keepFilledTargetIds,
    });
    state.gate5h.applied = applied.applied;
    state.gate5h.invariantsPassed = applied.invariantsPassed;
    state.gate5h.selectedDiscoveryCount = applied.selectedDiscoveryCount;
    state.gate5h.evidence = {
      acquisition: external.evidence,
      selectedDiscoveryCount: applied.selectedDiscoveryCount,
      skippedKeepFilledTargetIds: applied.skippedKeepFilledTargetIds,
      surgical: applied.preview?.evidence ?? null,
      replacements: replacementEvidence(
        applied.preview?.targets ?? [],
        external.discoveries,
        false,
      ),
    };
    if (!applied.invariantsPassed) {
      state.gate5h.failure = "SURGICAL_INVARIANT_FAILED_ABSTAIN";
      return input.plan;
    }
    return applied.plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.gate5h.failure = `SURGICAL_APPLY_FAILED_ABSTAIN: ${message}`;
    state.gate5h.invariantsPassed = true;
    state.gate5h.evidence = {
      acquisition: external.evidence,
      abstained: "SURGICAL_APPLY_ERROR",
      error: message,
    };
    return input.plan;
  }
}

function applyTargetScopedExternalDiscovery(input: {
  baseline: PlanRunResult;
  targets: RunTarget[];
  discoveries: Awaited<ReturnType<typeof resolveRuntimeExternalDiscovery>>["discoveries"];
  blockedMusicTrackIdsByTargetId: ReadonlyMap<string, ReadonlySet<string>>;
  eligibleTargetIds: ReadonlySet<string>;
  targetRuntime: NonNullable<ReturnType<typeof currentTargetDiscoveryRuntimeState>>;
}): {
  plan: PlanRunResult;
  applied: boolean;
  invariantsPassed: boolean;
  selectedDiscoveryCount: number;
  targetEvidence: unknown[];
  replacements: unknown[];
} {
  let workingPlan: PlanRunResult = {
    targets: input.baseline.targets.map((target) => ({
      ...target,
      result: target.result,
    })),
  };
  let remaining = [...input.discoveries];
  let selectedDiscoveryCount = 0;
  const targetEvidence: unknown[] = [];
  const replacements: unknown[] = [];
  const targetById = new Map(
    input.targets.map((target) => [target.targetPlaylistId, target] as const),
  );

  for (const planned of input.baseline.targets) {
    if (!input.eligibleTargetIds.has(planned.targetPlaylistId)) continue;
    const target = targetById.get(planned.targetPlaylistId);
    const policy = input.targetRuntime.policies.get(planned.targetPlaylistId);
    if (!target || !policy) continue;

    const caps = targetDiscoveryRuntimeCaps(policy.intensity);
    const current = workingPlan.targets.find(
      (row) => row.targetPlaylistId === planned.targetPlaylistId,
    );
    if (!current) continue;

    const applied = applyDiscoveryGate5H({
      baseline: { targets: [current] },
      targets: [target],
      discoveries: remaining,
      blockedMusicTrackIdsByTargetId: input.blockedMusicTrackIdsByTargetId,
      discoveryCeiling: caps.externalDiscoveryCeiling,
    });

    targetEvidence.push({
      targetPlaylistId: planned.targetPlaylistId,
      targetName: planned.name,
      intensity: policy.intensity,
      discoveryCeiling: caps.externalDiscoveryCeiling,
      applied: applied.applied,
      invariantsPassed: applied.invariantsPassed,
      selectedDiscoveryCount: applied.selectedDiscoveryCount,
      surgical: applied.preview?.evidence ?? null,
    });

    if (!applied.invariantsPassed) {
      return {
        plan: input.baseline,
        applied: false,
        invariantsPassed: false,
        selectedDiscoveryCount: 0,
        targetEvidence,
        replacements: [],
      };
    }

    const selected = replacementEvidence(
      applied.preview?.targets ?? [],
      input.discoveries,
      true,
    );
    replacements.push(...selected);
    selectedDiscoveryCount += applied.selectedDiscoveryCount;

    if (applied.applied) {
      const replacementTarget = applied.plan.targets[0];
      if (replacementTarget) {
        workingPlan = {
          targets: workingPlan.targets.map((row) =>
            row.targetPlaylistId === replacementTarget.targetPlaylistId
              ? replacementTarget
              : row,
          ),
        };
      }
    }

    const usedKeys = new Set(
      applied.preview?.targets.flatMap((preview) =>
        preview.replacements.map((replacement) => replacement.candidateKey),
      ) ?? [],
    );
    const usedIdentities = new Set(
      applied.preview?.targets.flatMap((preview) =>
        preview.replacements.map((replacement) =>
          candidateIdentity(replacement.discovery),
        ),
      ) ?? [],
    );
    remaining = remaining.filter(
      (candidate) =>
        !usedKeys.has(candidate.candidateKey) &&
        !usedIdentities.has(candidateIdentity(candidate.candidate)),
    );
  }

  return {
    plan: workingPlan,
    applied: selectedDiscoveryCount > 0,
    invariantsPassed: true,
    selectedDiscoveryCount,
    targetEvidence,
    replacements,
  };
}

function replacementEvidence(
  targets: Array<{
    targetPlaylistId: string;
    name: string;
    replacements: Array<{
      musicOrdinal: number;
      overallPosition: number;
      baseline: Candidate;
      discovery: Candidate;
      candidateKey: string;
      historyClass: string;
      pathLabel: string;
      resolutionReason: string;
      rawScore: number;
      adjustedScore: number;
      durationDeltaMs: number;
    }>;
  }>,
  discoveries: Awaited<ReturnType<typeof resolveRuntimeExternalDiscovery>>["discoveries"],
  includeFamily: boolean,
): unknown[] {
  return targets.flatMap((target) =>
    target.replacements.map((replacement) => {
      const resolved = discoveries.find(
        (candidate) => candidate.candidateKey === replacement.candidateKey,
      );
      return {
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        ...(includeFamily ? { family: "DISCOVERY" } : {}),
        musicOrdinal: replacement.musicOrdinal,
        overallPosition: replacement.overallPosition,
        baselineUri: replacement.baseline.uri,
        baselineTitle: replacement.baseline.title,
        discoveryUri: replacement.discovery.uri,
        discoveryTrackId: replacement.discovery.spotifyTrackId ?? null,
        discoveryTitle: replacement.discovery.title,
        discoveryArtist:
          replacement.discovery.primaryArtistName ??
          replacement.discovery.subtitle ??
          null,
        candidateKey: replacement.candidateKey,
        historyClass: replacement.historyClass,
        pathLabel: replacement.pathLabel,
        resolutionReason: replacement.resolutionReason,
        isrc: resolved?.isrc ?? null,
        rawScore: replacement.rawScore,
        adjustedScore: replacement.adjustedScore,
        durationDeltaMs: replacement.durationDeltaMs,
      };
    }),
  );
}

function candidateIdentity(candidate: Candidate): string {
  return candidate.spotifyTrackId?.trim()
    ? `track:${candidate.spotifyTrackId.trim()}`
    : `uri:${candidate.uri}`;
}

function mergeEvidence(
  current: Record<string, unknown> | null,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(current ?? {}), ...next };
}

export function discoveryRuntimeSummary(
  state: DiscoveryRuntimeState,
): Record<string, unknown> {
  return {
    policyVersion: state.policyVersion,
    enabled: state.enabled,
    reason: state.reason,
    userAllowlisted: state.reason === "ENABLED",
    applied: state.applied,
    rediscoveryCeiling: state.rediscoveryCeiling,
    failure: state.failure,
    evidence: state.evidence,
    gate5h: {
      enabled: state.gate5h.enabled,
      reason: state.gate5h.reason,
      attempted: state.gate5h.attempted,
      applied: state.gate5h.applied,
      invariantsPassed: state.gate5h.invariantsPassed,
      selectedDiscoveryCount: state.gate5h.selectedDiscoveryCount,
      failure: state.gate5h.failure,
      evidence: state.gate5h.evidence,
    },
  };
}

function discoveryMemoryCheckpoint(phase: string): DiscoveryMemoryCheckpoint {
  const memory = process.memoryUsage();
  return {
    phase,
    rssMiB: bytesToMiB(memory.rss),
    heapUsedMiB: bytesToMiB(memory.heapUsed),
    heapTotalMiB: bytesToMiB(memory.heapTotal),
    externalMiB: bytesToMiB(memory.external),
    arrayBuffersMiB: bytesToMiB(memory.arrayBuffers),
  };
}

function bytesToMiB(value: number): number {
  return Math.round((value / 1024 / 1024) * 10) / 10;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function parseBoolean(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function parseRediscoveryCeiling(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DISCOVERY_GATE4A_DEFAULT_REDISCOVERY_CEILING;
}
