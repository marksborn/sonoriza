import { LikedTrackAvailability } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildLikedTrackSourceSnapshot } from "@/services/music-preference/liked-track-source";
import {
  planRun,
  type Candidate,
  type PlanRunResult,
  type PlannerPools,
  type RunTarget,
} from "@/services/playlist-planner";
import { filterMusicCandidatesForRepeat } from "@/services/spotify/recently-played";

import { buildLikedTrackArbitrationShadowEvidence } from "./liked-track-source-arbitration-shadow";
import { currentMusicRepeatState } from "./music-repeat-runtime";

export const LIKED_TRACK_SOURCE_SHADOW_POLICY = {
  version: "source-liked-gate3b-v1",
  mode: "SHADOW_ONLY",
  activationRule: "MASTER_FLAG_AND_USER_ALLOWLIST_AND_TARGET_ID_ALLOWLIST",
  arbitration: "APPEND_AFTER_CURRENT_TARGET_MUSIC_POOL",
  fallbackRule: "ABSTAIN_AND_KEEP_CURRENT_PLAN",
  persistenceRule: "GENERATION_SUMMARY_ONLY",
} as const;

export type LikedTrackSourceShadowPolicyReason =
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "TARGET_ALLOWLIST_EMPTY"
  | "ENABLED";

export type LikedTrackSourceShadowContext = {
  pools: PlannerPools;
  plan: PlanRunResult;
  targets: RunTarget[];
  musicPoolByTargetId?: ReadonlyMap<string, Candidate[]>;
  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;
  blockedMusicTrackIdsByTargetId?: ReadonlyMap<string, ReadonlySet<string>>;
  initialReserved?: Iterable<string>;
};

export type PreparedLikedTrackSourceShadow = {
  enabled: boolean;
  targetIds: ReadonlySet<string>;
  candidates: Candidate[];
};

export function resolveLikedTrackSourceShadowPolicy(input: {
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  allowlistedTargetIds?: string | null;
}): {
  enabled: boolean;
  reason: LikedTrackSourceShadowPolicyReason;
  targetIds: ReadonlySet<string>;
} {
  const targetIds = parseSet(input.allowlistedTargetIds);
  if (!parseBoolean(input.masterEnabled)) {
    return { enabled: false, reason: "MASTER_DISABLED", targetIds };
  }
  const email = normalizeEmail(input.userEmail);
  if (!email) {
    return { enabled: false, reason: "USER_EMAIL_MISSING", targetIds };
  }
  const users = new Set(
    String(input.allowlistedEmails ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value): value is string => Boolean(value)),
  );
  if (!users.has(email)) {
    return { enabled: false, reason: "USER_NOT_ALLOWLISTED", targetIds };
  }
  if (targetIds.size === 0) {
    return { enabled: false, reason: "TARGET_ALLOWLIST_EMPTY", targetIds };
  }
  return { enabled: true, reason: "ENABLED", targetIds };
}

/**
 * SOURCE-LIKED-01 Gate 3B/3C.
 *
 * Prepares a local-only candidate set. A disabled/not-ready/error state never
 * blocks the authoritative generation and never changes its planner input.
 */
export async function prepareLikedTrackSourceShadowForCurrentRun(): Promise<PreparedLikedTrackSourceShadow> {
  const runState = currentMusicRepeatState();
  if (!runState) {
    return { enabled: false, targetIds: new Set(), candidates: [] };
  }

  const base = summaryBase();
  runState.likedTrackSourceShadow = base;

  try {
    const user = await prisma.user.findUnique({
      where: { id: runState.userId },
      select: { email: true },
    });
    const policy = resolveLikedTrackSourceShadowPolicy({
      userEmail: user?.email,
      masterEnabled: process.env.LIKED_TRACK_SOURCE_SHADOW_ENABLED,
      allowlistedEmails: process.env.LIKED_TRACK_SOURCE_SHADOW_USER_EMAILS,
      allowlistedTargetIds: process.env.LIKED_TRACK_SOURCE_SHADOW_TARGET_IDS,
    });

    runState.likedTrackSourceShadow = {
      ...base,
      policyEnabled: policy.enabled,
      policyReason: policy.reason,
      userAllowlisted:
        policy.reason !== "USER_NOT_ALLOWLISTED" && Boolean(user?.email),
      targetAllowlist: [...policy.targetIds],
    };

    if (!policy.enabled) {
      return { enabled: false, targetIds: policy.targetIds, candidates: [] };
    }

    const rows = await prisma.likedTrackPreference.findMany({
      where: { userId: runState.userId, isLiked: true },
      select: {
        spotifyTrackId: true,
        spotifyUri: true,
        trackName: true,
        primaryArtistId: true,
        primaryArtistName: true,
        albumId: true,
        albumName: true,
        durationMs: true,
        addedAt: true,
        availability: true,
        lastObservedAt: true,
      },
      orderBy: [{ addedAt: "desc" }, { spotifyTrackId: "asc" }],
    });
    const snapshot = buildLikedTrackSourceSnapshot(rows);
    const candidates = buildLikedTrackShadowCandidates(rows);
    const repeat = filterMusicCandidatesForRepeat(candidates, runState.context);

    runState.likedTrackSourceShadow = {
      ...(runState.likedTrackSourceShadow ?? base),
      sourceReady: snapshot.plannerMaterialization.ready,
      likedSourceTrackCount: snapshot.counts.activeLikedTracks,
      likedSourceResolvedCount: snapshot.counts.plannerReadyAvailable,
      likedSourceUnavailableCount: snapshot.counts.unavailable,
      likedSourceCandidatesRead: candidates.length,
      likedSourceCacheHits: candidates.length,
      likedSourceProviderCalls: 0,
      repeatEligibleCandidates: repeat.candidates.length,
      repeatBlockedCandidates: repeat.recentlyPlayedSkippedCount,
      missingTrackIdentityCandidates: repeat.missingTrackIdentitySkippedCount,
      sourceBlocker: snapshot.plannerMaterialization.blocker,
      attempted: false,
      reason: snapshot.plannerMaterialization.ready
        ? "READY_FOR_SHADOW_COMPARISON"
        : "SOURCE_NOT_READY",
    };

    if (!snapshot.plannerMaterialization.ready) {
      return { enabled: false, targetIds: policy.targetIds, candidates: [] };
    }

    return {
      enabled: true,
      targetIds: policy.targetIds,
      candidates: repeat.candidates,
    };
  } catch (error) {
    runState.likedTrackSourceShadow = {
      ...base,
      status: "ERROR",
      reason: "SHADOW_PREPARATION_FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
    return { enabled: false, targetIds: new Set(), candidates: [] };
  }
}

export function applyLikedTrackSourceShadowForCurrentRun(
  prepared: PreparedLikedTrackSourceShadow,
  context: LikedTrackSourceShadowContext,
): void {
  const runState = currentMusicRepeatState();
  if (!runState || !prepared.enabled) return;

  try {
    const allowedTargets = context.targets.filter((target) =>
      prepared.targetIds.has(target.targetPlaylistId),
    );
    if (allowedTargets.length === 0) {
      runState.likedTrackSourceShadow = {
        ...(runState.likedTrackSourceShadow ?? summaryBase()),
        attempted: false,
        reason: "NO_ALLOWLISTED_TARGET_IN_RUN",
      };
      return;
    }

    const currentFingerprint = planFingerprint(context.plan);
    const shadowMusicPoolByTargetId = new Map<string, Candidate[]>();
    const sourceAddedUrisByTargetId = new Map<string, Set<string>>();
    const targetInputs: Array<Record<string, unknown>> = [];

    for (const target of context.targets) {
      const currentPool =
        context.musicPoolByTargetId?.get(target.targetPlaylistId) ??
        context.pools.music;
      const currentUris = new Set(currentPool.map((candidate) => candidate.uri));
      const allowlisted = prepared.targetIds.has(target.targetPlaylistId);
      const blocked = context.blockedMusicTrackIdsByTargetId?.get(
        target.targetPlaylistId,
      );
      const sourceNew = allowlisted
        ? prepared.candidates.filter((candidate) => !currentUris.has(candidate.uri))
        : [];
      const sourceAddedUris = new Set(sourceNew.map((candidate) => candidate.uri));
      sourceAddedUrisByTargetId.set(target.targetPlaylistId, sourceAddedUris);
      shadowMusicPoolByTargetId.set(
        target.targetPlaylistId,
        dedupeByUri([...currentPool, ...sourceNew]),
      );

      const overlap = allowlisted
        ? prepared.candidates.filter((candidate) => currentUris.has(candidate.uri))
            .length
        : 0;
      const negativeBlocked = allowlisted
        ? sourceNew.filter(
            (candidate) =>
              Boolean(candidate.spotifyTrackId) &&
              Boolean(
                candidate.spotifyTrackId && blocked?.has(candidate.spotifyTrackId),
              ),
          ).length
        : 0;
      targetInputs.push({
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        allowlisted,
        currentMusicPoolCount: currentPool.length,
        likedCandidateCount: allowlisted ? prepared.candidates.length : 0,
        overlapCurrentPool: overlap,
        newToCurrentPool: sourceNew.length,
        negativeSignalBlocked: negativeBlocked,
        survivingBeforePlanner: Math.max(0, sourceNew.length - negativeBlocked),
      });
    }

    const shadowPools: PlannerPools = {
      ...context.pools,
      music: dedupeByUri([...context.pools.music, ...prepared.candidates]),
    };
    const shadowPlan = planRun({
      pools: shadowPools,
      targets: context.targets,
      musicPoolByTargetId: shadowMusicPoolByTargetId,
      preservedByTargetId: context.preservedByTargetId,
      blockedMusicTrackIdsByTargetId: context.blockedMusicTrackIdsByTargetId,
      initialReserved: context.initialReserved,
    });

    const comparisons = context.plan.targets.map((currentTarget) => {
      const shadowTarget = shadowPlan.targets.find(
        (target) => target.targetPlaylistId === currentTarget.targetPlaylistId,
      );
      if (!shadowTarget) {
        return {
          targetPlaylistId: currentTarget.targetPlaylistId,
          targetName: currentTarget.name,
          shadowMissing: true,
        };
      }
      const sourceUris =
        sourceAddedUrisByTargetId.get(currentTarget.targetPlaylistId) ?? new Set();
      const selectedFromLiked = shadowTarget.result.items.filter((item) =>
        sourceUris.has(item.uri),
      );
      const currentUris = new Set(
        currentTarget.result.items.map((item) => item.uri),
      );
      const shadowUris = new Set(shadowTarget.result.items.map((item) => item.uri));
      return {
        targetPlaylistId: currentTarget.targetPlaylistId,
        targetName: currentTarget.name,
        allowlisted: prepared.targetIds.has(currentTarget.targetPlaylistId),
        current: compactStats(currentTarget.result),
        shadow: compactStats(shadowTarget.result),
        likedSourceCandidatesSelected: selectedFromLiked.length,
        likedSourceSelectedSample: selectedFromLiked.slice(0, 10).map((item) => ({
          spotifyTrackId: item.spotifyTrackId ?? null,
          uri: item.uri,
          title: item.title,
          artist: item.primaryArtistName ?? null,
          durationMs: item.durationMs,
        })),
        selectedAddedVsCurrent: [...shadowUris].filter(
          (uri) => !currentUris.has(uri),
        ).length,
        selectedRemovedVsCurrent: [...currentUris].filter(
          (uri) => !shadowUris.has(uri),
        ).length,
      };
    });

    let arbitrationShadow: Record<string, unknown>;
    try {
      arbitrationShadow = buildLikedTrackArbitrationShadowEvidence({
        prepared,
        context,
      }) as unknown as Record<string, unknown>;
    } catch (error) {
      arbitrationShadow = {
        policyVersion: "source-liked-gate3c-v1",
        mode: "SHADOW_ONLY",
        plannerInfluence: false,
        status: "ERROR",
        reason: "ARBITRATION_SHADOW_FAILED",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const currentPlanUnchanged = planFingerprint(context.plan) === currentFingerprint;
    runState.likedTrackSourceShadow = {
      ...(runState.likedTrackSourceShadow ?? summaryBase()),
      status: currentPlanUnchanged ? "READY" : "ERROR",
      attempted: true,
      reason: currentPlanUnchanged
        ? "SHADOW_COMPARISON_COMPLETE"
        : "AUTHORITATIVE_PLAN_MUTATED",
      shadowOnly: true,
      plannerInfluence: false,
      dbWrites: false,
      spotifyWrites: false,
      providerReads: false,
      currentPlanUnchanged,
      targetInputs,
      targets: comparisons,
      likedSourceCandidatesSelected: comparisons.reduce(
        (sum, item) =>
          sum +
          ("likedSourceCandidatesSelected" in item
            ? Number(item.likedSourceCandidatesSelected ?? 0)
            : 0),
        0,
      ),
      arbitrationShadow,
    };
  } catch (error) {
    runState.likedTrackSourceShadow = {
      ...(runState.likedTrackSourceShadow ?? summaryBase()),
      status: "ERROR",
      attempted: true,
      reason: "SHADOW_COMPARISON_FAILED",
      plannerInfluence: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildLikedTrackShadowCandidates(
  rows: ReadonlyArray<{
    spotifyTrackId: string;
    spotifyUri: string | null;
    trackName: string | null;
    primaryArtistId: string | null;
    primaryArtistName: string | null;
    albumId: string | null;
    albumName: string | null;
    durationMs: number | null;
    availability: LikedTrackAvailability;
  }>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const row of rows) {
    if (row.availability !== LikedTrackAvailability.AVAILABLE) continue;
    const uri = clean(row.spotifyUri);
    const title = clean(row.trackName);
    const spotifyTrackId = clean(row.spotifyTrackId);
    const durationMs = validDurationMs(row.durationMs);
    if (!uri || !title || !spotifyTrackId || durationMs === null) continue;
    candidates.push({
      uri,
      type: "MUSIC",
      title,
      subtitle: clean(row.primaryArtistName) ?? undefined,
      spotifyTrackId,
      primaryArtistId: clean(row.primaryArtistId) ?? undefined,
      primaryArtistName: clean(row.primaryArtistName) ?? undefined,
      albumId: clean(row.albumId) ?? undefined,
      albumName: clean(row.albumName) ?? undefined,
      durationMs,
    });
  }
  return dedupeByUri(candidates);
}

function compactStats(result: PlanRunResult["targets"][number]["result"]) {
  return {
    itemCount: result.items.length,
    musicCount: result.stats.musicCount,
    podcastCount: result.stats.podcastCount,
    totalDurationMs: result.stats.totalDurationMs,
    musicDurationMs: result.stats.musicDurationMs,
    podcastDurationMs: result.stats.podcastDurationMs,
    compositionQualityPassed: result.stats.compositionQualityPassed,
    sequenceQualityPassed: result.stats.sequenceQualityPassed,
    distinctArtistCount: result.stats.distinctArtistCount,
    distinctAlbumCount: result.stats.distinctAlbumCount,
    artistLimitRejectedCount: result.stats.artistLimitRejectedCount,
    albumLimitRejectedCount: result.stats.albumLimitRejectedCount,
    unfilledSlots: result.stats.unfilledSlots,
    poolExhausted: result.stats.poolExhausted,
  };
}

function planFingerprint(plan: PlanRunResult): string {
  return JSON.stringify(
    plan.targets.map((target) => ({
      id: target.targetPlaylistId,
      uris: target.result.items.map((item) => item.uri),
      totalDurationMs: target.result.stats.totalDurationMs,
    })),
  );
}

function summaryBase(): Record<string, unknown> {
  return {
    policyVersion: LIKED_TRACK_SOURCE_SHADOW_POLICY.version,
    mode: LIKED_TRACK_SOURCE_SHADOW_POLICY.mode,
    arbitration: LIKED_TRACK_SOURCE_SHADOW_POLICY.arbitration,
    shadowOnly: true,
    plannerInfluence: false,
    providerReads: false,
    spotifyWrites: false,
    dbWrites: false,
    likedSourceProviderCalls: 0,
    status: "DISABLED",
    policyEnabled: false,
    attempted: false,
    reason: "MASTER_DISABLED",
  };
}

function dedupeByUri(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.uri || seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    result.push(candidate);
  }
  return result;
}

function parseBoolean(value: string | null | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function parseSet(value: string | null | undefined): ReadonlySet<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function validDurationMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
