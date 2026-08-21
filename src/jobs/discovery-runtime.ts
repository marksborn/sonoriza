import { AsyncLocalStorage } from "node:async_hooks";

import {
  buildCompleteDiscoveryMusicSelection,
  collectCompleteDiscoverySourceUniverse,
  type DiscoveryPreviewSource,
} from "@/services/music-discovery/planner-preview";
import { getCompleteMusicDiscoveryProfile } from "@/services/music-discovery/complete-profile";
import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";
import type { Candidate } from "@/services/playlist-planner";

import { filterMusicBatchForCurrentRun } from "./music-repeat-runtime";

export const DISCOVERY_GATE4A_POLICY_VERSION = "gate4a-runtime-v1";
export const DISCOVERY_GATE4A_SEQUENCE_TERMINAL_UNDERFILL_TOLERANCE_MS = 30_000;
export const DISCOVERY_GATE4A_DEFAULT_REDISCOVERY_CEILING = 0.25;

export type DiscoveryRuntimePolicyReason =
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "ENABLED";

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

    // PERF-01: these three operations can each materialize a large dataset.
    // Run them sequentially so their transient query/result allocations do not
    // overlap in Node. Their final reduced outputs still coexist for scoring.
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
