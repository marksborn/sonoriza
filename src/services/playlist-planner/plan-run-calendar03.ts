import {
  capturePodcast06PlannerShadow,
  applyPodcast06PlannerRuntimeToCandidates,
} from "./podcast-cadence-shadow-runtime";
import {
  calendar03TargetIsActive,
  currentCalendar03PlannerRuntimeState,
  recordCalendar03RuntimeTargets,
  type Calendar03RuntimeTargetEvidence,
} from "./calendar-event-composition-runtime";
import {
  projectCalendar03EventComposition,
  type Calendar03EventCompositionShadow,
} from "./calendar-event-composition-shadow";
import {
  planRun as basePlanRun,
  type PlanRunInput,
  type PlanRunResult,
  type RunTarget,
} from "./plan-run";
import type {
  Candidate,
  PlanResult,
  PlannedDurationBlock,
  PlannedItem,
} from "./types";
import type { PlannerPools } from "./planner";

export type {
  PlanRunInput,
  PlanRunResult,
  PlanRunTargetResult,
  RunTarget,
} from "./plan-run";

/**
 * CALENDAR-03 Gate 3 controlled seam.
 *
 * With no runtime state, OFF, or any activation guard failure, this delegates
 * exactly to the pre-Gate-3 planRun. SHADOW also returns the exact legacy plan
 * while recording a read-only projection. ACTIVE may influence planning only
 * for a single-target run whose target is explicitly allowlisted and has a
 * persisted PODCAST_THEN_MUSIC policy. Multi-target ACTIVE runs fail closed to
 * the legacy planner until cross-target rollout is validated separately.
 */
export function planRun(input: PlanRunInput): PlanRunResult {
  const state = currentCalendar03PlannerRuntimeState();
  if (!state || state.effectiveMode === "OFF") {
    return basePlanRun(input);
  }

  const orderedTargets = [...input.targets].sort((a, b) => a.priority - b.priority);
  const podcastRuntimePool = applyPodcast06PlannerRuntimeToCandidates(
    input.pools.podcasts,
  );

  const activeCandidates = orderedTargets.filter((target) => {
    const policy = state.policies.get(target.targetPlaylistId);
    return Boolean(
      policy?.eventCompositionPolicy === "PODCAST_THEN_MUSIC" &&
      calendar03TargetIsActive(state, target.targetPlaylistId),
    );
  });

  const activeSingleTarget =
    state.effectiveMode === "ACTIVE" &&
    orderedTargets.length === 1 &&
    activeCandidates.length === 1;

  if (activeSingleTarget) {
    const target = orderedTargets[0]!;
    const policy = state.policies.get(target.targetPlaylistId)!;
    const preserved = input.preservedByTargetId?.get(target.targetPlaylistId) ?? [];

    if (preserved.length === 0 && target.durationBlocks?.length) {
      const targetPools = poolsForTarget(input, target, podcastRuntimePool);
      const projection = projectCalendar03EventComposition({
        policy,
        blocks: target.durationBlocks,
        rules: target.rules,
        pools: targetPools,
        reserved: input.initialReserved,
      });

      if (projection.status === "READY_SHADOW") {
        const result = projectionToPlanResult(target, projection);
        const runResult: PlanRunResult = {
          targets: [
            {
              targetPlaylistId: target.targetPlaylistId,
              name: target.name,
              result,
            },
          ],
        };
        recordCalendar03RuntimeTargets(state, [
          evidenceFromProjection(target, policy, projection, true),
        ]);
        capturePodcast06PlannerShadow({
          candidates: input.pools.podcasts,
          plannedItems: result.items,
        });
        return runResult;
      }
    }

    const fallback = basePlanRun(input);
    const status = preserved.length > 0
      ? "ABSTAIN_PRESERVED_ITEMS"
      : "ABSTAIN_NO_PER_EVENT_BLOCKS";
    recordCalendar03RuntimeTargets(state, [
      {
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        policy,
        status,
        plannerInfluence: false,
        selectedPodcastUris: [],
        blockDiagnostics: [],
      },
    ]);
    return fallback;
  }

  const legacy = basePlanRun(input);
  const legacyByTargetId = new Map(
    legacy.targets.map((entry) => [entry.targetPlaylistId, entry] as const),
  );
  const globalReserved = new Set<string>(input.initialReserved ?? []);
  const globalProgramCounts = new Map<string, number>();
  const evidence: Calendar03RuntimeTargetEvidence[] = [];

  for (const target of orderedTargets) {
    const policy = state.policies.get(target.targetPlaylistId);
    const legacyTarget = legacyByTargetId.get(target.targetPlaylistId);
    if (!policy || !legacyTarget) continue;

    const allowlisted = state.activeTargetAllowlist.has(target.targetPlaylistId);
    if (state.effectiveMode === "ACTIVE" && !allowlisted) {
      evidence.push({
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        policy,
        status: "ABSTAIN_TARGET_NOT_ALLOWED",
        plannerInfluence: false,
        selectedPodcastUris: [],
        blockDiagnostics: [],
      });
    } else if (
      state.effectiveMode === "ACTIVE" &&
      allowlisted &&
      policy.eventCompositionPolicy === "PODCAST_THEN_MUSIC" &&
      orderedTargets.length !== 1
    ) {
      evidence.push({
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        policy,
        status: "ABSTAIN_MULTI_TARGET_ACTIVE_SCOPE",
        plannerInfluence: false,
        selectedPodcastUris: [],
        blockDiagnostics: [],
      });
    } else if (policy.eventCompositionPolicy === "PODCAST_THEN_MUSIC") {
      const preserved = input.preservedByTargetId?.get(target.targetPlaylistId) ?? [];
      if (preserved.length > 0) {
        evidence.push({
          targetPlaylistId: target.targetPlaylistId,
          targetName: target.name,
          policy,
          status: "ABSTAIN_PRESERVED_ITEMS",
          plannerInfluence: false,
          selectedPodcastUris: [],
          blockDiagnostics: [],
        });
      } else {
        const filteredPodcasts = filterPodcastPoolForGlobalCounts({
          candidates: podcastRuntimePool,
          reserved: globalReserved,
          globalProgramCounts,
          target,
        });
        const targetPools = poolsForTarget(input, target, filteredPodcasts);
        const projection = projectCalendar03EventComposition({
          policy,
          blocks: target.durationBlocks ?? [],
          rules: target.rules,
          pools: targetPools,
          reserved: globalReserved,
        });
        evidence.push(evidenceFromProjection(target, policy, projection, false));
      }
    } else {
      evidence.push({
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        policy,
        status: "ABSTAIN_INHERIT_DESTINATION",
        plannerInfluence: false,
        selectedPodcastUris: [],
        blockDiagnostics: [],
      });
    }

    for (const uri of legacyTarget.result.usedUris) globalReserved.add(uri);
    countPodcasts(legacyTarget.result.items, globalProgramCounts);
  }

  recordCalendar03RuntimeTargets(state, evidence);
  return legacy;
}

function poolsForTarget(
  input: PlanRunInput,
  target: RunTarget,
  podcasts: Candidate[],
): PlannerPools {
  const music = input.musicPoolByTargetId?.get(target.targetPlaylistId) ?? input.pools.music;
  const blocked = input.blockedMusicTrackIdsByTargetId?.get(target.targetPlaylistId);
  return {
    ...input.pools,
    podcasts,
    music:
      blocked && blocked.size > 0
        ? music.filter(
            (candidate) =>
              candidate.type !== "MUSIC" ||
              !candidate.spotifyTrackId ||
              !blocked.has(candidate.spotifyTrackId),
          )
        : music,
  };
}

function filterPodcastPoolForGlobalCounts(input: {
  candidates: Candidate[];
  reserved: ReadonlySet<string>;
  globalProgramCounts: ReadonlyMap<string, number>;
  target: RunTarget;
}): Candidate[] {
  const includedByProgram = new Map<string, number>();
  const output: Candidate[] = [];

  for (const candidate of input.candidates) {
    if (candidate.type !== "PODCAST") continue;
    if (input.reserved.has(candidate.uri)) continue;
    const programId = candidate.programId?.trim();
    if (!programId) {
      output.push(candidate);
      continue;
    }
    const cap = effectiveProgramCap(candidate, input.target);
    const already = input.globalProgramCounts.get(programId) ?? 0;
    const remaining = Math.max(0, cap - already);
    const included = includedByProgram.get(programId) ?? 0;
    if (included >= remaining) continue;
    includedByProgram.set(programId, included + 1);
    output.push(candidate);
  }
  return output;
}

function effectiveProgramCap(candidate: Candidate, target: RunTarget): number {
  const targetCap = Math.max(
    1,
    Math.trunc(target.rules.maxEpisodesPerProgram || 1),
  );
  const showCap = candidate.podcastMaxEpisodesPerCycle;
  if (!Number.isInteger(showCap) || Number(showCap) < 1) return targetCap;
  return Math.min(targetCap, Number(showCap));
}

function countPodcasts(items: Candidate[], counts: Map<string, number>) {
  for (const item of items) {
    if (item.type !== "PODCAST" || !item.programId) continue;
    counts.set(item.programId, (counts.get(item.programId) ?? 0) + 1);
  }
}

function evidenceFromProjection(
  target: RunTarget,
  policy: Calendar03RuntimeTargetEvidence["policy"],
  projection: Calendar03EventCompositionShadow,
  plannerInfluence: boolean,
): Calendar03RuntimeTargetEvidence {
  return {
    targetPlaylistId: target.targetPlaylistId,
    targetName: target.name,
    policy,
    status: projection.status,
    plannerInfluence,
    selectedPodcastUris: projection.items
      .filter((item) => item.type === "PODCAST")
      .map((item) => item.uri),
    blockDiagnostics: projection.blocks.map((block) => ({
      index: block.index,
      key: block.key,
      targetDurationMs: block.targetDurationMs,
      podcastUsableDurationMs: block.podcastUsableDurationMs,
      diagnosticCodes: [...block.diagnosticCodes],
    })),
  };
}

function projectionToPlanResult(
  target: RunTarget,
  projection: Calendar03EventCompositionShadow,
): PlanResult {
  const items = projection.items.map((item, position) => ({
    ...item,
    position,
  })) as PlannedItem[];
  const totalDurationMs = sumDuration(items);
  const musicItems = items.filter((item) => item.type === "MUSIC");
  const podcastItems = items.filter((item) => item.type === "PODCAST");
  const musicDurationMs = sumDuration(musicItems);
  const podcastDurationMs = sumDuration(podcastItems);
  const actualPodcastPercent = totalDurationMs > 0
    ? round1((podcastDurationMs / totalDurationMs) * 100)
    : 0;
  const originalBlocks = target.durationBlocks ?? [];
  const blocks: PlannedDurationBlock[] = projection.blocks.map((block) => {
    const original = originalBlocks[block.index] ?? {
      key: block.key,
      targetDurationMs: block.targetDurationMs,
    };
    const blockItems = items.filter(
      (item) => item.planningBlockIndex === block.index,
    );
    const start = blockItems[0]?.position ?? items.length;
    return {
      ...original,
      index: block.index,
      itemStartPosition: start,
      itemEndPositionExclusive: start + blockItems.length,
      itemCount: blockItems.length,
      filledDurationMs: block.filledDurationMs,
      deficitMs: block.deficitMs,
      musicDurationMs: block.musicDurationMs,
      podcastDurationMs: block.podcastDurationMs,
      compositionQualityPassed: block.musicCompositionQualityPassed,
      stoppedAtPatternIndex: null,
      sequenceStopReason: block.deficitMs > 0 ? "NO_FITTING_CANDIDATE" : "TARGET_REACHED",
    };
  });
  const targetDurationMs = originalBlocks.reduce(
    (sum, block) => sum + Math.max(0, block.targetDurationMs),
    0,
  );
  const deficitMs = blocks.reduce((sum, block) => sum + block.deficitMs, 0);
  const compositionQualityPassed = blocks.every(
    (block) => block.compositionQualityPassed,
  );
  const artistIds = new Set(
    musicItems.flatMap((item) => (item.primaryArtistId ? [item.primaryArtistId] : [])),
  );
  const albumIds = new Set(
    musicItems.flatMap((item) => (item.albumId ? [item.albumId] : [])),
  );

  return {
    items,
    usedUris: new Set(projection.usedUris),
    stats: {
      compositionMode: target.rules.compositionMode,
      totalDurationMs,
      musicDurationMs,
      podcastDurationMs,
      musicCount: musicItems.length,
      podcastCount: podcastItems.length,
      actualPodcastPercent,
      requestedPodcastPercent: target.rules.podcastPercent,
      podcastShortfallMs: 0,
      musicShortfallMs: deficitMs,
      mixDeviationPoints: 0,
      mixQualityPassed: compositionQualityPassed,
      compositionQualityPassed,
      unfilledSlots: blocks.filter((block) => block.deficitMs > 0).length,
      poolExhausted: projection.blocks.some((block) => block.musicPoolExhausted),
      podcastIdentityMissingCount: 0,
      podcastDurationExceededCount: 0,
      distinctArtistCount: artistIds.size,
      distinctAlbumCount: albumIds.size,
      artistLimitRejectedCount: 0,
      albumLimitRejectedCount: 0,
      missingArtistIdentityRejectedCount: 0,
      missingAlbumIdentityRejectedCount: 0,
      sequenceSlotsRequested: 0,
      sequenceSlotsFilled: 0,
      sequenceUnfilledSlots: 0,
      completedCycles: 0,
      finalPartialCycleSlots: 0,
      stoppedAtPatternIndex: null,
      sequenceQualityPassed:
        target.rules.compositionMode === "SEQUENCE"
          ? compositionQualityPassed
          : null,
      sequenceStopReason: compositionQualityPassed
        ? "TARGET_REACHED"
        : "NO_FITTING_CANDIDATE",
      segmentation: {
        mode: "PER_EVENT",
        targetDurationMs,
        filledDurationMs: totalDurationMs,
        deficitMs,
        blocks,
      },
    },
  };
}

function sumDuration(items: Candidate[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
