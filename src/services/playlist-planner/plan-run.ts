import { planPlaylist, type PlannerPools } from "./planner";
import type {
  Candidate,
  DurationPlanningBlock,
  PlannedItem,
  PlanResult,
  PlaylistRules,
} from "./types";

export interface RunTarget {
  targetPlaylistId: string;
  name: string;
  /** Lower priority is planned first and reserves its content. */
  priority: number;
  rules: PlaylistRules;
  /** CALENDAR-02: absent keeps the legacy single-budget planner path. */
  durationBlocks?: DurationPlanningBlock[];
}

export interface PlanRunInput {
  /** Candidate pools shared by every target (built from the user's sources). */
  pools: PlannerPools;
  targets: RunTarget[];
  /**
   * DISCOVER-DEST-01: optional MUSIC ordering keyed by target id. Podcasts and
   * every other planner rule remain shared/authoritative. Missing entries fall
   * back to the shared MUSIC pool, preserving every existing caller.
   */
  musicPoolByTargetId?: ReadonlyMap<string, Candidate[]>;
  /** SCHEDULE-01 valid remote items keyed by target id. */
  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;
  /**
   * MUSIC-05: Spotify track ids temporarily ineligible as new music for a given
   * target, keyed by target id. Applied only to freshly picked candidates, so
   * already-preserved valid remote items are never reinterpreted as skips.
   */
  blockedMusicTrackIdsByTargetId?: ReadonlyMap<string, ReadonlySet<string>>;
  initialReserved?: Iterable<string>;
}

export interface PlanRunTargetResult {
  targetPlaylistId: string;
  name: string;
  result: PlanResult;
}

export interface PlanRunResult {
  targets: PlanRunTargetResult[];
}

/**
 * Plans every target playlist of a single run in priority order, threading both
 * URI reservations and podcast-program counts forward. PODCAST-05 makes the
 * latter explicit: a show cap is consumed by the run, not reset per playlist.
 *
 * CALENDAR-02 keeps the exact same planner for PER_EVENT. The only difference
 * is that the planner is called once per independent duration block, with the
 * selected items/constraints from earlier blocks threaded forward, and the
 * resulting items are concatenated into one final destination.
 *
 * Pure function: no Spotify, no database. The orchestration layer builds the
 * pools and persists / applies the returned plans.
 */
export function planRun({
  pools,
  targets,
  musicPoolByTargetId,
  preservedByTargetId,
  blockedMusicTrackIdsByTargetId,
  initialReserved,
}: PlanRunInput): PlanRunResult {
  const ordered = [...targets].sort((a, b) => a.priority - b.priority);
  const reserved = new Set<string>(initialReserved ?? []);
  const globalPodcastProgramCounts = new Map<string, number>();
  const results: PlanRunTargetResult[] = [];

  for (const target of ordered) {
    const targetMusicPool =
      musicPoolByTargetId?.get(target.targetPlaylistId) ?? pools.music;
    const podcastPool = applyGlobalPodcastPolicyToPool({
      candidates: pools.podcasts,
      reserved,
      globalProgramCounts: globalPodcastProgramCounts,
      rules: target.rules,
    });
    const baseTargetPools: PlannerPools = {
      ...pools,
      music: targetMusicPool,
      podcasts: podcastPool,
    };
    const blockedMusicTrackIds = blockedMusicTrackIdsByTargetId?.get(
      target.targetPlaylistId,
    );
    const targetPools =
      blockedMusicTrackIds && blockedMusicTrackIds.size > 0
        ? {
            ...baseTargetPools,
            music: baseTargetPools.music.filter(
              (candidate) =>
                candidate.type !== "MUSIC" ||
                !candidate.spotifyTrackId ||
                !blockedMusicTrackIds.has(candidate.spotifyTrackId),
            ),
          }
        : baseTargetPools;
    const preserved = applyGlobalPodcastPolicyToPreserved({
      candidates: preservedByTargetId?.get(target.targetPlaylistId) ?? [],
      globalProgramCounts: globalPodcastProgramCounts,
      rules: target.rules,
    });
    const result = target.durationBlocks
      ? planSegmentedTarget({
          target,
          pools: targetPools,
          reserved,
          preserved,
        })
      : planPlaylist({
          rules: target.rules,
          pools: targetPools,
          reserved,
          preserved,
        });
    for (const uri of result.usedUris) reserved.add(uri);
    countPlannedPodcasts(result.items, globalPodcastProgramCounts);
    results.push({
      targetPlaylistId: target.targetPlaylistId,
      name: target.name,
      result,
    });
  }

  return { targets: results };
}

function applyGlobalPodcastPolicyToPool(input: {
  candidates: Candidate[];
  reserved: ReadonlySet<string>;
  globalProgramCounts: ReadonlyMap<string, number>;
  rules: PlaylistRules;
}): Candidate[] {
  const includedByProgram = new Map<string, number>();
  const strictProgramOffered = new Set<string>();
  const output: Candidate[] = [];

  for (const candidate of input.candidates) {
    if (candidate.type !== "PODCAST") {
      output.push(candidate);
      continue;
    }
    const programId = candidate.programId;
    if (!programId) {
      output.push(candidate);
      continue;
    }
    if (input.reserved.has(candidate.uri)) continue;

    const cap = effectiveGlobalPodcastCap(candidate, input.rules);
    const alreadyPlanned = input.globalProgramCounts.get(programId) ?? 0;
    const remaining = Math.max(0, cap - alreadyPlanned);
    if (remaining <= 0) continue;

    if (candidate.podcastStrictSequence) {
      if (strictProgramOffered.has(programId)) continue;
      strictProgramOffered.add(programId);

      // Conservative sequence protection: expose only the next episode of a
      // strict show to a destination. If it cannot fit this destination at all,
      // do not let a later episode jump ahead. Another destination may still
      // receive it later in the same run.
      const durationMs = Math.max(0, candidate.durationMs);
      const maxPodcastDurationMs = input.rules.maxPodcastDurationMs ?? null;
      if (durationMs <= 0) continue;
      if (durationMs > Math.max(0, input.rules.targetDurationMs)) continue;
      if (maxPodcastDurationMs !== null && durationMs > maxPodcastDurationMs) {
        continue;
      }
      output.push(candidate);
      continue;
    }

    const offered = includedByProgram.get(programId) ?? 0;
    if (offered >= remaining) continue;
    includedByProgram.set(programId, offered + 1);
    output.push(candidate);
  }

  return output;
}

function applyGlobalPodcastPolicyToPreserved(input: {
  candidates: Candidate[];
  globalProgramCounts: ReadonlyMap<string, number>;
  rules: PlaylistRules;
}): Candidate[] {
  const includedByProgram = new Map<string, number>();
  return input.candidates.filter((candidate) => {
    if (candidate.type !== "PODCAST" || !candidate.programId) return true;
    const programId = candidate.programId;
    const cap = effectiveGlobalPodcastCap(candidate, input.rules);
    const alreadyPlanned = input.globalProgramCounts.get(programId) ?? 0;
    const included = includedByProgram.get(programId) ?? 0;
    if (alreadyPlanned + included >= cap) return false;
    includedByProgram.set(programId, included + 1);
    return true;
  });
}

function effectiveGlobalPodcastCap(
  candidate: Candidate,
  rules: PlaylistRules,
): number {
  const targetCap = Math.max(1, Math.trunc(rules.maxEpisodesPerProgram || 1));
  const showCap = candidate.podcastMaxEpisodesPerCycle;
  if (!Number.isInteger(showCap) || Number(showCap) < 1) return targetCap;
  return Math.min(targetCap, Number(showCap));
}

function countPlannedPodcasts(
  items: Candidate[],
  counts: Map<string, number>,
): void {
  for (const item of items) {
    if (item.type !== "PODCAST" || !item.programId) continue;
    counts.set(item.programId, (counts.get(item.programId) ?? 0) + 1);
  }
}

function planSegmentedTarget(input: {
  target: RunTarget;
  pools: PlannerPools;
  reserved: ReadonlySet<string>;
  preserved?: Candidate[];
}): PlanResult {
  const blocks = input.target.durationBlocks ?? [];
  const localReserved = new Set(input.reserved);
  const selected: PlannedItem[] = [];
  const usedUris = new Set<string>();
  const blockResults: Array<{
    block: DurationPlanningBlock;
    result: PlanResult;
    startPosition: number;
  }> = [];
  const preservedQueue = [...(input.preserved ?? [])];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!;
    const targetDurationMs = Math.max(0, block.targetDurationMs);
    const preservedForBlock: Candidate[] = [];
    let preservedDurationMs = 0;

    // KEEP_FILLED compatibility: keep valid remote items as a stable prefix.
    // If the next preserved item belongs to a later block, do not insert a new
    // item before it. A preserved item too large for every remaining block is
    // intentionally left out of the final plan so maintenance can remove it.
    while (preservedQueue.length > 0) {
      const candidate = preservedQueue[0]!;
      const durationMs = Math.max(0, candidate.durationMs);
      if (durationMs <= 0) {
        preservedQueue.shift();
        continue;
      }
      if (preservedDurationMs + durationMs <= targetDurationMs) {
        preservedForBlock.push(candidate);
        preservedDurationMs += durationMs;
        preservedQueue.shift();
        continue;
      }

      const fitsLaterBlock = blocks
        .slice(blockIndex + 1)
        .some((future) => durationMs <= Math.max(0, future.targetDurationMs));
      if (!fitsLaterBlock) {
        preservedQueue.shift();
        continue;
      }
      break;
    }

    const preservingFuturePrefix = preservedQueue.length > 0;
    const blockPools = preservingFuturePrefix
      ? { music: [], podcasts: [] }
      : input.pools;
    const startPosition = selected.length;
    const result = planPlaylist({
      rules: {
        ...input.target.rules,
        targetDurationMs,
      },
      pools: blockPools,
      reserved: localReserved,
      preserved: preservedForBlock,
      constraintSeed: selected,
      strictDurationBoundary: true,
      sequenceStartIndex: selected.length,
    });

    for (const item of result.items) {
      const planned: PlannedItem = {
        ...item,
        position: selected.length,
        planningBlockIndex: blockIndex,
      };
      selected.push(planned);
    }
    for (const uri of result.usedUris) {
      localReserved.add(uri);
      usedUris.add(uri);
    }
    blockResults.push({ block, result, startPosition });
  }

  return aggregateSegmentedResult(input.target.rules, selected, usedUris, blockResults);
}

function aggregateSegmentedResult(
  rules: PlaylistRules,
  items: PlannedItem[],
  usedUris: Set<string>,
  blocks: Array<{
    block: DurationPlanningBlock;
    result: PlanResult;
    startPosition: number;
  }>,
): PlanResult {
  const totalDurationMs = sumDuration(items);
  const musicItems = items.filter((item) => item.type === "MUSIC");
  const podcastItems = items.filter((item) => item.type === "PODCAST");
  const musicDurationMs = sumDuration(musicItems);
  const podcastDurationMs = sumDuration(podcastItems);
  const requestedPodcastPercent = Math.min(100, Math.max(0, rules.podcastPercent));
  const actualPodcastPercent =
    totalDurationMs > 0
      ? round1((podcastDurationMs / totalDurationMs) * 100)
      : requestedPodcastPercent;
  const targetDurationMs = blocks.reduce(
    (sum, entry) => sum + Math.max(0, entry.block.targetDurationMs),
    0,
  );
  const plannedBlocks = blocks.map((entry, index) => {
    const filledDurationMs = entry.result.stats.totalDurationMs;
    return {
      ...entry.block,
      index,
      itemStartPosition: entry.startPosition,
      itemEndPositionExclusive: entry.startPosition + entry.result.items.length,
      itemCount: entry.result.items.length,
      filledDurationMs,
      deficitMs: Math.max(0, entry.block.targetDurationMs - filledDurationMs),
      musicDurationMs: entry.result.stats.musicDurationMs,
      podcastDurationMs: entry.result.stats.podcastDurationMs,
      compositionQualityPassed: entry.result.stats.compositionQualityPassed,
      stoppedAtPatternIndex: entry.result.stats.stoppedAtPatternIndex,
      sequenceStopReason: entry.result.stats.sequenceStopReason,
    };
  });
  const blockDeficitMs = plannedBlocks.reduce((sum, block) => sum + block.deficitMs, 0);
  const blockStats = blocks.map((entry) => entry.result.stats);
  const sequenceStop = blockStats.find(
    (stats) =>
      stats.sequenceStopReason !== null &&
      stats.sequenceStopReason !== "TARGET_REACHED",
  );
  const artistIds = new Set(
    musicItems.flatMap((item) => (item.primaryArtistId ? [item.primaryArtistId] : [])),
  );
  const albumIds = new Set(
    musicItems.flatMap((item) => (item.albumId ? [item.albumId] : [])),
  );
  const compositionQualityPassed = blockStats.every(
    (stats) => stats.compositionQualityPassed,
  );
  const sequenceQualityPassed =
    rules.compositionMode === "SEQUENCE"
      ? blockStats.every((stats) => stats.sequenceQualityPassed === true)
      : null;

  return {
    items,
    usedUris,
    stats: {
      compositionMode: rules.compositionMode,
      totalDurationMs,
      musicDurationMs,
      podcastDurationMs,
      musicCount: musicItems.length,
      podcastCount: podcastItems.length,
      actualPodcastPercent,
      requestedPodcastPercent,
      podcastShortfallMs: sumStat(blockStats, "podcastShortfallMs"),
      musicShortfallMs: sumStat(blockStats, "musicShortfallMs"),
      mixDeviationPoints:
        rules.compositionMode === "PROPORTION"
          ? Math.max(0, ...blockStats.map((stats) => stats.mixDeviationPoints))
          : 0,
      mixQualityPassed: compositionQualityPassed,
      compositionQualityPassed,
      unfilledSlots: sumStat(blockStats, "unfilledSlots"),
      poolExhausted: blockDeficitMs > 0,
      podcastIdentityMissingCount: Math.max(
        0,
        ...blockStats.map((stats) => stats.podcastIdentityMissingCount),
      ),
      podcastDurationExceededCount: Math.max(
        0,
        ...blockStats.map((stats) => stats.podcastDurationExceededCount),
      ),
      distinctArtistCount: artistIds.size,
      distinctAlbumCount: albumIds.size,
      artistLimitRejectedCount: sumStat(blockStats, "artistLimitRejectedCount"),
      albumLimitRejectedCount: sumStat(blockStats, "albumLimitRejectedCount"),
      missingArtistIdentityRejectedCount: sumStat(
        blockStats,
        "missingArtistIdentityRejectedCount",
      ),
      missingAlbumIdentityRejectedCount: sumStat(
        blockStats,
        "missingAlbumIdentityRejectedCount",
      ),
      sequenceSlotsRequested: sumStat(blockStats, "sequenceSlotsRequested"),
      sequenceSlotsFilled: sumStat(blockStats, "sequenceSlotsFilled"),
      sequenceUnfilledSlots: sumStat(blockStats, "sequenceUnfilledSlots"),
      completedCycles:
        rules.compositionMode === "SEQUENCE" && rules.sequencePattern.length > 0
          ? Math.floor(items.length / rules.sequencePattern.length)
          : 0,
      finalPartialCycleSlots:
        rules.compositionMode === "SEQUENCE" && rules.sequencePattern.length > 0
          ? items.length % rules.sequencePattern.length
          : 0,
      stoppedAtPatternIndex: sequenceStop?.stoppedAtPatternIndex ?? null,
      sequenceQualityPassed,
      sequenceStopReason:
        rules.compositionMode !== "SEQUENCE"
          ? null
          : sequenceStop?.sequenceStopReason ??
            (blockDeficitMs === 0 ? "TARGET_REACHED" : null),
      segmentation: {
        mode: "PER_EVENT",
        targetDurationMs,
        filledDurationMs: totalDurationMs,
        deficitMs: blockDeficitMs,
        blocks: plannedBlocks,
      },
    },
  };
}

function sumDuration(items: Candidate[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
}

function sumStat<K extends keyof PlanResult["stats"]>(
  stats: PlanResult["stats"][],
  key: K,
): number {
  return stats.reduce((sum, entry) => {
    const value = entry[key];
    return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
