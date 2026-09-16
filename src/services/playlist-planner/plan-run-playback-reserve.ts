import {
  currentPlaybackReserveShadowRuntimeState,
  recordPlaybackReserveShadowEvidence,
} from "@/services/playback-reserve-shadow-runtime";
import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";
import {
  applyPodcast07PlannerRuntimeToCandidates,
} from "@/services/spotify/podcast-07-runtime";

import {
  planRun as basePlanRun,
  type PlanRunInput,
  type PlanRunResult as BasePlanRunResult,
} from "./plan-run-podcast07";
import { applyPodcast06PlannerRuntimeToCandidates } from "./podcast-cadence-shadow-runtime";
import {
  projectDurationReserveShadow,
  type PlaybackReserveDurationTargetShadow,
} from "./playback-reserve-duration-shadow";
import {
  LEGACY_GLOBAL_SHARING_POLICY,
} from "./target-sharing-shadow";
import {
  addTargetReservations,
  cloneReservationMap,
  reservationsForTarget,
} from "./target-sharing-runtime";
import type { Candidate } from "./types";

export type {
  PlanRunInput,
  PlanRunTargetResult,
  RunTarget,
} from "./plan-run-podcast07";

export type PlaybackReserveInactiveTargetShadow = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  status: "DISABLED_NONE" | "DEFERRED_GATE4" | "NO_POLICY";
  plannerInfluence: false;
  spotifyWriteInfluence: false;
  additionalProviderReads: false;
  candidateCoverage: "PRIMARY_COLLECTION_ONLY";
  policy: EffectivePlaybackReservePolicySnapshot | null;
  primary: Readonly<{
    itemCount: number;
    totalDurationMs: number;
    compositionQualityPassed: boolean;
  }>;
  reserve: null;
}>;

export type PlaybackReserveTargetShadowEvidence =
  | PlaybackReserveDurationTargetShadow
  | PlaybackReserveInactiveTargetShadow;

export type PlaybackReserveRunShadowEvidence = Readonly<{
  gate: 3;
  mode: "SHADOW";
  plannerInfluence: false;
  spotifyWriteInfluence: false;
  additionalProviderReads: false;
  status: "READY_SHADOW";
  targetCount: number;
  readyTargetCount: number;
  shortfallTargetCount: number;
  targets: readonly PlaybackReserveTargetShadowEvidence[];
}>;

export type PlanRunResult = BasePlanRunResult &
  Readonly<{
    playbackReserveShadow?: PlaybackReserveRunShadowEvidence;
  }>;

/**
 * PLAYBACK-RESERVE-01 Gate 3 outer planner seam.
 *
 * PRIMARY is always planned first by the complete pre-existing stack. Only
 * after that immutable result exists do we project DURATION reserve segments.
 * The projection receives no authority to modify PRIMARY, request more provider
 * pages or influence Spotify writes.
 */
export function planRun(input: PlanRunInput): PlanRunResult {
  const primary = basePlanRun(input);
  const state = currentPlaybackReserveShadowRuntimeState();
  if (!state) return primary;

  const orderedTargets = [...input.targets].sort((a, b) => a.priority - b.priority);
  const primaryByTargetId = new Map(
    primary.targets.map((entry) => [entry.targetPlaylistId, entry] as const),
  );

  // Match the canonical podcast runtime order used by the nested planner stack:
  // PODCAST-07 first, then PODCAST-06.
  const podcastRuntimePool = applyPodcast06PlannerRuntimeToCandidates(
    applyPodcast07PlannerRuntimeToCandidates(input.pools.podcasts),
  );

  // Shadow-only ownership is intentionally separate from the productive planner.
  // Seed every PRIMARY first so no RESERVE can steal capacity/content from a
  // later PRIMARY. Reserve selections are then added only to this shadow map.
  const shadowReservationOwners = cloneReservationMap(
    input.externalReservationsByUri,
  );
  const shadowPodcastProgramCounts = new Map<string, number>();

  for (const target of orderedTargets) {
    const planned = primaryByTargetId.get(target.targetPlaylistId);
    if (!planned) continue;
    const sharingPolicy =
      input.sharingPolicyByTargetId?.get(target.targetPlaylistId) ??
      LEGACY_GLOBAL_SHARING_POLICY;

    addTargetReservations({
      targetPlaylistId: target.targetPlaylistId,
      sharingPolicy,
      uris: planned.result.items.map((item) => item.uri),
      reservationsByUri: shadowReservationOwners,
    });
    countPodcastPrograms(planned.result.items, shadowPodcastProgramCounts);
  }

  const targets: PlaybackReserveTargetShadowEvidence[] = [];

  for (const target of orderedTargets) {
    const planned = primaryByTargetId.get(target.targetPlaylistId);
    if (!planned) continue;

    const policy = state.policies.get(target.targetPlaylistId) ?? null;
    if (!policy) {
      targets.push(inactiveEvidence(target, planned.result, null, "NO_POLICY"));
      continue;
    }
    if (policy.reserveMode === "NONE") {
      targets.push(inactiveEvidence(target, planned.result, policy, "DISABLED_NONE"));
      continue;
    }
    if (policy.reserveMode !== "DURATION") {
      targets.push(inactiveEvidence(target, planned.result, policy, "DEFERRED_GATE4"));
      continue;
    }

    const allowedSourceIds = input.sourceIdsByTargetId?.get(target.targetPlaylistId);
    const targetMusicPool = filterConfiguredSourceCandidates(
      input.musicPoolByTargetId?.get(target.targetPlaylistId) ?? input.pools.music,
      allowedSourceIds,
    );
    const targetPodcastPool = filterConfiguredSourceCandidates(
      podcastRuntimePool,
      allowedSourceIds,
    );
    const blockedMusicTrackIds = input.blockedMusicTrackIdsByTargetId?.get(
      target.targetPlaylistId,
    );
    const music =
      blockedMusicTrackIds && blockedMusicTrackIds.size > 0
        ? targetMusicPool.filter(
            (candidate) =>
              candidate.type !== "MUSIC" ||
              !candidate.spotifyTrackId ||
              !blockedMusicTrackIds.has(candidate.spotifyTrackId),
          )
        : targetMusicPool;

    const sharingPolicy =
      input.sharingPolicyByTargetId?.get(target.targetPlaylistId) ??
      LEGACY_GLOBAL_SHARING_POLICY;
    const shadowReservation = reservationsForTarget({
      targetPlaylistId: target.targetPlaylistId,
      effectiveSharingPolicy: sharingPolicy,
      legacyHardReserved: input.initialReserved,
      reservationsByUri: shadowReservationOwners,
    });
    const reserved = new Set(shadowReservation.forbiddenUris);
    for (const item of planned.result.items) reserved.add(item.uri);

    const projection = projectDurationReserveShadow({
      targetPlaylistId: target.targetPlaylistId,
      targetName: target.name,
      policy,
      primary: planned.result,
      rules: target.rules,
      pools: {
        music,
        podcasts: targetPodcastPool,
      },
      reservedUris: reserved,
      podcastProgramCounts: shadowPodcastProgramCounts,
    });
    targets.push(projection);

    addTargetReservations({
      targetPlaylistId: target.targetPlaylistId,
      sharingPolicy,
      uris: projection.reserve.selectedItems.map((item) => item.uri),
      reservationsByUri: shadowReservationOwners,
    });
    countPodcastPrograms(
      projection.reserve.selectedItems,
      shadowPodcastProgramCounts,
    );
  }

  const evidence: PlaybackReserveRunShadowEvidence = Object.freeze({
    gate: 3,
    mode: "SHADOW",
    plannerInfluence: false,
    spotifyWriteInfluence: false,
    additionalProviderReads: false,
    status: "READY_SHADOW",
    targetCount: targets.length,
    readyTargetCount: targets.filter(
      (target) => target.status === "READY_SHADOW",
    ).length,
    shortfallTargetCount: targets.filter(
      (target) => target.status === "SHORTFALL",
    ).length,
    targets: Object.freeze(targets),
  });

  recordPlaybackReserveShadowEvidence(evidence);
  return {
    ...primary,
    playbackReserveShadow: evidence,
  };
}

function inactiveEvidence(
  target: PlanRunInput["targets"][number],
  primary: BasePlanRunResult["targets"][number]["result"],
  policy: EffectivePlaybackReservePolicySnapshot | null,
  status: PlaybackReserveInactiveTargetShadow["status"],
): PlaybackReserveInactiveTargetShadow {
  return Object.freeze({
    targetPlaylistId: target.targetPlaylistId,
    targetName: target.name,
    status,
    plannerInfluence: false,
    spotifyWriteInfluence: false,
    additionalProviderReads: false,
    candidateCoverage: "PRIMARY_COLLECTION_ONLY",
    policy,
    primary: Object.freeze({
      itemCount: primary.items.length,
      totalDurationMs: primary.stats.totalDurationMs,
      compositionQualityPassed: primary.stats.compositionQualityPassed,
    }),
    reserve: null,
  });
}

function filterConfiguredSourceCandidates(
  candidates: readonly Candidate[],
  allowedSourceIds: ReadonlySet<string> | undefined,
): Candidate[] {
  if (!allowedSourceIds) return [...candidates];
  return candidates.filter((candidate) => {
    if (!candidate.sourcePlaylistId) return true;
    return allowedSourceIds.has(candidate.sourcePlaylistId);
  });
}

function countPodcastPrograms(
  items: readonly {
    type: Candidate["type"];
    programId?: string | null;
  }[],
  counts: Map<string, number>,
): void {
  for (const item of items) {
    if (item.type !== "PODCAST" || !item.programId) continue;
    counts.set(item.programId, (counts.get(item.programId) ?? 0) + 1);
  }
}
