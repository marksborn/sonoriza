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
          stoppedEarly: sources.some((candidateSource) => !candidateSource.done),
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
      onBatch?.(source, batch);
      if (source.kind === "MUSIC") pools.music.push(...batch.candidates);
      else pools.podcasts.push(...batch.candidates);
    }

    plan = planRun({ pools, targets });
    qualityFailures = failedTargets(plan);
    planningNeeds = targetsNeedingMoreCandidates(plan, targetById);
    requestedKinds = new Set(planningNeeds.flatMap((need) => need.kinds));
    onRound?.({
      round: rounds,
      requestedKinds: [...requestedKinds],
      musicCandidates: pools.music.length,
      podcastCandidates: pools.podcasts.length,
      qualityPassed: qualityFailures.length === 0,
    });
  }

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

function failedTargets(plan: PlanRunResult): PlanRunResult["targets"] {
  return plan.targets.filter((target) => !target.result.stats.compositionQualityPassed);
}

type PlanningNeed = {
  targetPlaylistId: string;
  kinds: IncrementalSourceKind[];
};

function targetsNeedingMoreCandidates(
  plan: PlanRunResult,
  targetById: Map<string, RunTarget>,
): PlanningNeed[] {
  return plan.targets.flatMap((planned) => {
    const target = targetById.get(planned.targetPlaylistId);
    if (!target) return [];
    const stats = planned.result.stats;
    if (stats.compositionQualityPassed) return [];

    const kinds = new Set<IncrementalSourceKind>();
    if (target.rules.compositionMode === "SEQUENCE") {
      const pattern = target.rules.sequencePattern;
      const index = stats.stoppedAtPatternIndex;
      if (index !== null && pattern[index]) kinds.add(pattern[index]);
      if (kinds.size === 0 && stats.poolExhausted) {
        for (const kind of pattern) kinds.add(kind);
      }
    } else {
      if (stats.musicShortfallMs > 0) kinds.add("MUSIC");
      if (stats.podcastShortfallMs > 0) kinds.add("PODCAST");
      if (kinds.size === 0 && stats.poolExhausted) {
        if (target.rules.podcastPercent < 100) kinds.add("MUSIC");
        if (target.rules.podcastPercent > 0) kinds.add("PODCAST");
      }
    }

    return kinds.size > 0
      ? [{ targetPlaylistId: planned.targetPlaylistId, kinds: [...kinds] }]
      : [];
  });
}

function sourceKindsUsedByTargets(targets: RunTarget[]): IncrementalSourceKind[] {
  const kinds = new Set<IncrementalSourceKind>();
  for (const target of targets) {
    if (target.rules.compositionMode === "SEQUENCE") {
      for (const kind of target.rules.sequencePattern) kinds.add(kind);
    } else {
      if (target.rules.podcastPercent < 100) kinds.add("MUSIC");
      if (target.rules.podcastPercent > 0) kinds.add("PODCAST");
    }
  }
  return [...kinds];
}
