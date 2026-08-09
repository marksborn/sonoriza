import {
  planRun,
  type Candidate,
  type PlanRunResult,
  type PlannerPools,
  type RunTarget,
} from "@/services/playlist-planner";

import {
  filterMusicBatchForCurrentRun,
  revalidateMusicRepeatBeforeRealWrite,
} from "./music-repeat-runtime";

export type IncrementalSourceKind = "MUSIC" | "PODCAST";

export type IncrementalSourceBatch = {
  candidates: Candidate[];
  done: boolean;
  playbackPositionMissingCount?: number;
  fullyPlayedSkippedCount?: number;
  podcastNotStartedCount?: number;
  podcastInProgressCount?: number;
  podcastCompletedCount?: number;
  unavailableMusicSkippedCount?: number;
  recentlyPlayedSkippedCount?: number;
  missingTrackIdentitySkippedCount?: number;
  genericPodcastSuppressedCount?: number;
  fromCache?: boolean;
};

export type IncrementalCandidateSource = {
  id: string;
  label: string;
  kind: IncrementalSourceKind;
  readonly done: boolean;
  readNext(): Promise<IncrementalSourceBatch>;
};

export type IncrementalSourceFailure<
  TSource extends IncrementalCandidateSource = IncrementalCandidateSource,
> = {
  source: TSource;
  error: unknown;
};

export type IncrementalPlanningRound = {
  round: number;
  requestedKinds: IncrementalSourceKind[];
  musicCandidates: number;
  podcastCandidates: number;
  qualityPassed: boolean;
};

export type IncrementalPlanningResult<
  TSource extends IncrementalCandidateSource = IncrementalCandidateSource,
> = {
  pools: PlannerPools;
  plan: PlanRunResult;
  qualityFailures: PlanRunResult["targets"];
  readSourceIds: Set<string>;
  rounds: number;
  stoppedEarly: boolean;
  failure: IncrementalSourceFailure<TSource> | null;
};

type CollectIncrementallyOptions<TSource extends IncrementalCandidateSource> = {
  sources: TSource[];
  targets: RunTarget[];
  onBatch?: (source: TSource, batch: IncrementalSourceBatch) => void;
  onRound?: (round: IncrementalPlanningRound) => void;
};

export async function collectIncrementally<
  TSource extends IncrementalCandidateSource,
>({ sources, targets, onBatch, onRound }: CollectIncrementallyOptions<TSource>): Promise<IncrementalPlanningResult<TSource>> {
  const pools: PlannerPools = { music: [], podcasts: [] };
  const readSourceIds = new Set<string>();
  const targetById = new Map(targets.map((target) => [target.targetPlaylistId, target]));
  const relevantKinds = sourceKindsUsedByTargets(targets);

  let requestedKinds = new Set<IncrementalSourceKind>(relevantKinds);
  let rounds = 0;
  let plan = planRun({ pools, targets });
  let qualityFailures = failedTargets(plan);
  let planningNeeds = targetsNeedingMoreCandidates(plan, targetById);

  if (planningNeeds.length === 0 && qualityFailures.length === 0) {
    await revalidateMusicRepeatBeforeRealWrite(plan);
    return {
      pools,
      plan,
      qualityFailures,
      readSourceIds,
      rounds,
      stoppedEarly: sources.some((source) => !source.done),
      failure: null,
    };
  }

  while (requestedKinds.size > 0) {
    const readable = sources.filter(
      (source) => !source.done && requestedKinds.has(source.kind),
    );
    if (readable.length === 0) break;

    rounds += 1;
    for (const source of readable) {
      let batch: IncrementalSourceBatch;
      try {
        batch = await source.readNext();
      } catch (error) {
        return {
          pools,
          plan,
          qualityFailures,
          readSourceIds,
          rounds,
          stoppedEarly: false,
          failure: { source, error },
        };
      }

      if (source.kind === "MUSIC") {
        const filtered = filterMusicBatchForCurrentRun(batch.candidates);
        batch = {
          ...batch,
          candidates: filtered.candidates,
          recentlyPlayedSkippedCount:
            (batch.recentlyPlayedSkippedCount ?? 0) +
            filtered.recentlyPlayedSkippedCount,
          missingTrackIdentitySkippedCount:
            (batch.missingTrackIdentitySkippedCount ?? 0) +
            filtered.missingTrackIdentitySkippedCount,
        };
      }

      readSourceIds.add(source.id);
      if (source.kind === "MUSIC") {
        pools.music = dedupeByUri([...pools.music, ...batch.candidates]);
      } else {
        pools.podcasts.push(...batch.candidates);
      }
      onBatch?.(source, batch);
    }

    plan = planRun({ pools, targets });
    qualityFailures = failedTargets(plan);
    planningNeeds = targetsNeedingMoreCandidates(plan, targetById);
    onRound?.({
      round: rounds,
      requestedKinds: [...requestedKinds],
      musicCandidates: pools.music.length,
      podcastCandidates: pools.podcasts.length,
      qualityPassed: qualityFailures.length === 0 && planningNeeds.length === 0,
    });

    if (qualityFailures.length === 0 && planningNeeds.length === 0) {
      await revalidateMusicRepeatBeforeRealWrite(plan);
      return {
        pools,
        plan,
        qualityFailures,
        readSourceIds,
        rounds,
        stoppedEarly: sources.some((source) => !source.done),
        failure: null,
      };
    }

    requestedKinds = inferNeededKinds(planningNeeds, targetById);
    if (requestedKinds.size === 0) {
      requestedKinds = new Set(
        relevantKinds.filter((kind) =>
          sources.some((source) => source.kind === kind && !source.done),
        ),
      );
    }
  }

  await revalidateMusicRepeatBeforeRealWrite(plan);
  return {
    pools,
    plan,
    qualityFailures,
    readSourceIds,
    rounds,
    stoppedEarly: false,
    failure: null,
  };
}

function failedTargets(plan: PlanRunResult): PlanRunResult["targets"] {
  return plan.targets.filter(
    (planned) => !planned.result.stats.compositionQualityPassed,
  );
}

function targetsNeedingMoreCandidates(
  plan: PlanRunResult,
  targetById: Map<string, RunTarget>,
): PlanRunResult["targets"] {
  return plan.targets.filter((planned) => {
    const target = targetById.get(planned.targetPlaylistId);
    if (!target) return false;
    const stats = planned.result.stats;
    if (!stats.compositionQualityPassed) return true;
    return (
      target.rules.compositionMode === "SEQUENCE" &&
      stats.totalDurationMs < target.rules.targetDurationMs &&
      stats.stoppedAtPatternIndex !== null
    );
  });
}

function sourceKindsUsedByTargets(targets: RunTarget[]): IncrementalSourceKind[] {
  let music = false;
  let podcast = false;

  for (const target of targets) {
    if (target.rules.targetDurationMs <= 0) continue;
    if (target.rules.compositionMode === "SEQUENCE") {
      music ||= target.rules.sequencePattern.includes("MUSIC");
      podcast ||= target.rules.sequencePattern.includes("PODCAST");
    } else {
      music ||= target.rules.podcastPercent < 100;
      podcast ||= target.rules.podcastPercent > 0;
    }
  }

  return [
    ...(music ? (["MUSIC"] as const) : []),
    ...(podcast ? (["PODCAST"] as const) : []),
  ];
}

function inferNeededKinds(
  needs: PlanRunResult["targets"],
  targetById: Map<string, RunTarget>,
): Set<IncrementalSourceKind> {
  const needed = new Set<IncrementalSourceKind>();

  for (const planned of needs) {
    const stats = planned.result.stats;
    const target = targetById.get(planned.targetPlaylistId);
    if (!target) continue;

    if (target.rules.compositionMode === "SEQUENCE") {
      const index = stats.stoppedAtPatternIndex;
      if (index !== null) {
        const kind = target.rules.sequencePattern[index];
        if (kind) needed.add(kind);
      }
      continue;
    }

    const sizeBefore = needed.size;
    if (
      stats.podcastShortfallMs > 0 ||
      stats.actualPodcastPercent < stats.requestedPodcastPercent
    ) {
      needed.add("PODCAST");
    }
    if (
      stats.musicShortfallMs > 0 ||
      stats.actualPodcastPercent > stats.requestedPodcastPercent
    ) {
      needed.add("MUSIC");
    }

    if (stats.poolExhausted && needed.size === sizeBefore) {
      if (target.rules.podcastPercent > 0) needed.add("PODCAST");
      if (target.rules.podcastPercent < 100) needed.add("MUSIC");
    }
  }

  return needed;
}

function dedupeByUri(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    out.push(candidate);
  }
  return out;
}
