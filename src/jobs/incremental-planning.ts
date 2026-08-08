import {
  planRun,
  type Candidate,
  type PlanRunResult,
  type PlannerPools,
  type RunTarget,
} from "@/services/playlist-planner";

export type IncrementalSourceKind = "MUSIC" | "PODCAST";

export type IncrementalSourceBatch = {
  candidates: Candidate[];
  done: boolean;
  playbackPositionMissingCount?: number;
  fullyPlayedSkippedCount?: number;
  unavailableMusicSkippedCount?: number;
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

/**
 * Reads Spotify sources lazily in provider-sized batches and replans after each
 * round. Once every target has a valid plan, unread pages are deliberately left
 * untouched. When a plan still fails, only source kinds that can improve that
 * failure are advanced on the next round.
 *
 * Sources are read sequentially. This is intentionally conservative: the
 * quota/rate-limit window benefits more from avoiding bursts than from shaving
 * a few milliseconds off source collection.
 */
export async function collectIncrementally<
  TSource extends IncrementalCandidateSource,
>({
  sources,
  targets,
  onBatch,
  onRound,
}: CollectIncrementallyOptions<TSource>): Promise<IncrementalPlanningResult<TSource>> {
  const pools: PlannerPools = { music: [], podcasts: [] };
  const readSourceIds = new Set<string>();
  const targetById = new Map(targets.map((target) => [target.targetPlaylistId, target]));
  const relevantKinds = sourceKindsUsedByTargets(targets);

  let requestedKinds = new Set<IncrementalSourceKind>(relevantKinds);
  let rounds = 0;
  let plan = planRun({ pools, targets });
  let qualityFailures = failedTargets(plan);

  // No target requires Spotify content (for example, only zero-duration CLEAR
  // targets). Do not read any source just to prove that nothing is needed.
  if (qualityFailures.length === 0) {
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

      readSourceIds.add(source.id);
      if (source.kind === "MUSIC") {
        pools.music = dedupeByUri([...pools.music, ...batch.candidates]);
      } else {
        // Keep duplicate podcast copies until the planner applies program
        // identity rules. A malformed duplicate from one source must not hide a
        // valid copy coming from another source.
        pools.podcasts.push(...batch.candidates);
      }
      onBatch?.(source, batch);
    }

    plan = planRun({ pools, targets });
    qualityFailures = failedTargets(plan);
    onRound?.({
      round: rounds,
      requestedKinds: [...requestedKinds],
      musicCandidates: pools.music.length,
      podcastCandidates: pools.podcasts.length,
      qualityPassed: qualityFailures.length === 0,
    });

    if (qualityFailures.length === 0) {
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

    requestedKinds = inferNeededKinds(qualityFailures, targetById);

    // Defensive fallback: if a future planner failure shape does not map to a
    // specific shortfall, continue only with still-relevant source kinds rather
    // than incorrectly declaring exhaustion after one page.
    if (requestedKinds.size === 0) {
      requestedKinds = new Set(
        relevantKinds.filter((kind) =>
          sources.some((source) => source.kind === kind && !source.done),
        ),
      );
    }
  }

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
  return plan.targets.filter((planned) => !planned.result.stats.mixQualityPassed);
}

function sourceKindsUsedByTargets(targets: RunTarget[]): IncrementalSourceKind[] {
  let music = false;
  let podcast = false;

  for (const target of targets) {
    if (target.rules.targetDurationMs <= 0) continue;
    if (
      target.rules.podcastPercent < 100 ||
      target.rules.sequencePattern.includes("MUSIC")
    ) {
      music = true;
    }
    if (
      target.rules.podcastPercent > 0 ||
      target.rules.sequencePattern.includes("PODCAST")
    ) {
      podcast = true;
    }
  }

  return [
    ...(music ? (["MUSIC"] as const) : []),
    ...(podcast ? (["PODCAST"] as const) : []),
  ];
}

function inferNeededKinds(
  failures: PlanRunResult["targets"],
  targetById: Map<string, RunTarget>,
): Set<IncrementalSourceKind> {
  const needed = new Set<IncrementalSourceKind>();

  for (const failure of failures) {
    const stats = failure.result.stats;
    const target = targetById.get(failure.targetPlaylistId);
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

    // poolExhausted alone does not mean both kinds are short. Only fall back to
    // every kind used by this target when the planner gave us no directional
    // shortfall/deviation signal at all.
    if (stats.poolExhausted && target && needed.size === sizeBefore) {
      if (
        target.rules.podcastPercent > 0 ||
        target.rules.sequencePattern.includes("PODCAST")
      ) {
        needed.add("PODCAST");
      }
      if (
        target.rules.podcastPercent < 100 ||
        target.rules.sequencePattern.includes("MUSIC")
      ) {
        needed.add("MUSIC");
      }
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
