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
  projectCountReserveShadow,
  type PlaybackReserveCountTargetShadow,
} from "./playback-reserve-count-shadow";
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
import type { Candidate, PlannedItem } from "./types";

export type {
  PlanRunInput,
  PlanRunTargetResult,
  RunTarget,
} from "./plan-run-podcast07";

export type PlaybackReserveInactiveTargetShadow = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  status: "DISABLED_NONE" | "NO_POLICY";
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
  | PlaybackReserveCountTargetShadow
  | PlaybackReserveInactiveTargetShadow;

export type PlaybackReserveRunShadowEvidence = Readonly<{
  gate: 5 | 7;
  mode: "SHADOW" | "ACTIVE";
  plannerInfluence: boolean;
  spotifyWriteInfluence: boolean;
  additionalProviderReads: false;
  status: "READY_SHADOW" | "READY_ACTIVE";
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
 * PLAYBACK-RESERVE-01 Gate 7 outer planner seam.
 *
 * PRIMARY remains authoritative and is always planned first by the complete
 * pre-existing stack. SHADOW projects the reserve exactly as Gates 3-5 did and
 * returns PRIMARY unchanged. Controlled ACTIVE is authorized only by the Gate 7
 * runtime and appends the already-projected RESERVE suffix to the physical plan.
 * PRIMARY stats/quality remain untouched so RESERVE can never hide PRIMARY
 * shortfall. No additional provider reads are introduced.
 */
export function planRun(input: PlanRunInput): PlanRunResult {
  const primary = basePlanRun(input);
  const state = currentPlaybackReserveShadowRuntimeState();
  if (!state || state.effectiveMode === "OFF") return primary;

  const orderedTargets = [...input.targets].sort((a, b) => a.priority - b.priority);
  const primaryByTargetId = new Map(
    primary.targets.map((entry) => [entry.targetPlaylistId, entry] as const),
  );

  // Match the canonical podcast runtime order used by the nested planner stack:
  // PODCAST-07 first, then PODCAST-06.
  const podcastRuntimePool = applyPodcast06PlannerRuntimeToCandidates(
    applyPodcast07PlannerRuntimeToCandidates(input.pools.podcasts),
  );

  // Reserve ownership is intentionally separate while PRIMARY is being planned.
  // Seed every PRIMARY first so RESERVE can never steal content from a later
  // PRIMARY. In Gate 7 ACTIVE is single-target, but this invariant also keeps
  // SHADOW multi-target diagnostics equivalent to the previous gates.
  const reserveReservationOwners = cloneReservationMap(
    input.externalReservationsByUri,
  );
  const reservePodcastProgramCounts = new Map<string, number>();

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
      reservationsByUri: reserveReservationOwners,
    });
    countPodcastPrograms(planned.result.items, reservePodcastProgramCounts);
  }

  const targets: PlaybackReserveTargetShadowEvidence[] = [];
  const productiveResultByTargetId = new Map(
    primary.targets.map((entry) => [entry.targetPlaylistId, entry] as const),
  );

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
    const reserveReservation = reservationsForTarget({
      targetPlaylistId: target.targetPlaylistId,
      effectiveSharingPolicy: sharingPolicy,
      legacyHardReserved: input.initialReserved,
      reservationsByUri: reserveReservationOwners,
    });
    const reserved = new Set(reserveReservation.forbiddenUris);
    for (const item of planned.result.items) reserved.add(item.uri);

    const commonInput = {
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
      podcastProgramCounts: reservePodcastProgramCounts,
    };

    const projection =
      policy.reserveMode === "DURATION"
        ? projectDurationReserveShadow(commonInput)
        : projectCountReserveShadow(commonInput);
    targets.push(projection);

    addTargetReservations({
      targetPlaylistId: target.targetPlaylistId,
      sharingPolicy,
      uris: projection.reserve.selectedItems.map((item) => item.uri),
      reservationsByUri: reserveReservationOwners,
    });
    countPodcastPrograms(
      projection.reserve.selectedItems,
      reservePodcastProgramCounts,
    );

    if (state.effectiveMode === "ACTIVE") {
      const candidateByUri = new Map<string, Candidate>();
      for (const candidate of [...music, ...targetPodcastPool]) {
        if (!candidateByUri.has(candidate.uri)) candidateByUri.set(candidate.uri, candidate);
      }

      const reserveItems: PlannedItem[] = projection.reserve.selectedItems.map(
        (selected) => {
          const candidate = candidateByUri.get(selected.uri);
          if (!candidate) {
            throw new Error(
              `PLAYBACK-RESERVE Gate 7 could not reconstruct selected candidate ${selected.uri}`,
            );
          }
          return {
            ...candidate,
            position: selected.position,
          };
        },
      );

      const usedUris = new Set(planned.result.usedUris);
      for (const item of reserveItems) usedUris.add(item.uri);

      productiveResultByTargetId.set(target.targetPlaylistId, {
        ...planned,
        result: {
          ...planned.result,
          items: [...planned.result.items, ...reserveItems],
          usedUris,
          // PRIMARY stats remain the only quality authority. RESERVE diagnostics
          // live in playbackReserveShadow/runtime evidence and cannot make a
          // short PRIMARY appear complete.
          stats: planned.result.stats,
        },
      });
    }
  }

  const active = state.effectiveMode === "ACTIVE";
  const evidence: PlaybackReserveRunShadowEvidence = Object.freeze({
    gate: active ? 7 : 5,
    mode: active ? "ACTIVE" : "SHADOW",
    plannerInfluence: active,
    spotifyWriteInfluence: active && state.spotifyWriteInfluence,
    additionalProviderReads: false,
    status: active ? "READY_ACTIVE" : "READY_SHADOW",
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
    targets: active
      ? primary.targets.map(
          (entry) => productiveResultByTargetId.get(entry.targetPlaylistId) ?? entry,
        )
      : primary.targets,
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
