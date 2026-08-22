import { AsyncLocalStorage } from "node:async_hooks";

import { getCompleteMusicDiscoveryProfile } from "@/services/music-discovery/complete-profile";
import { resolveRuntimeExternalDiscovery } from "@/services/music-discovery/external-discovery-runtime";
import {
  applyDiscoveryGate5H,
  resolveDiscoveryGate5HPolicy,
  type DiscoveryGate5HPolicyReason,
} from "@/services/music-discovery/planner-discovery-gate5h";
import {
  buildCompleteDiscoveryMusicSelection,
  collectCompleteDiscoverySourceUniverse,
  type DiscoveryPreviewSource,
} from "@/services/music-discovery/planner-preview";
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
>(sources: TSource[]): Promise<{
  rankedMusic: Candidate[];
  podcastSources: TSource[];
  completedMusicSourceIds: string[];
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
    const sourceUniverse = await collectCompleteDiscoverySourceUniverse(musicSources);
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
      podcastSources,
      completedMusicSourceIds: sourceUniverse.evidence.sources.map((source) => source.id),
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
  try {
    const external = await resolveRuntimeExternalDiscovery({
      userId: state.userId,
      asOf: state.asOf,
    });
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
      return input.plan;
    }

    if (external.discoveries.length === 0) {
      state.gate5h.invariantsPassed = true;
      state.gate5h.evidence = {
        acquisition: external.evidence,
        abstained: "NO_RESOLVED_DISCOVERY",
      };
      return input.plan;
    }

    // External acquisition introduces a real-time gap after the collector's
    // original MUSIC-01 pre-write check. Refresh once before exposing any new
    // discovery candidate to the final plan.
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
      replacements:
        applied.preview?.targets.flatMap((target) =>
          target.replacements.map((replacement) => ({
            targetPlaylistId: target.targetPlaylistId,
            targetName: target.name,
            musicOrdinal: replacement.musicOrdinal,
            overallPosition: replacement.overallPosition,
            baselineUri: replacement.baseline.uri,
            baselineTitle: replacement.baseline.title,
            discoveryUri: replacement.discovery.uri,
            discoveryTitle: replacement.discovery.title,
            discoveryArtist:
              replacement.discovery.primaryArtistName ??
              replacement.discovery.subtitle ??
              null,
            adjustedScore: replacement.adjustedScore,
            durationDeltaMs: replacement.durationDeltaMs,
          })),
        ) ?? [],
    };
    if (!applied.invariantsPassed) {
      state.gate5h.failure = "SURGICAL_INVARIANT_FAILED_ABSTAIN";
      return input.plan;
    }
    return applied.plan;
  } catch (error) {
    state.gate5h.failure = error instanceof Error ? error.message : String(error);
    throw error;
  }
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
