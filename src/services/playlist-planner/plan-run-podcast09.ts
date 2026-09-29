import {
  applyPodcast06PlannerRuntimeToCandidates,
  currentPodcast06PlannerShadowRuntimeState,
  runWithPodcast06PlannerShadowRuntimeState,
} from "./podcast-cadence-shadow-runtime";
import { projectPodcastContinuationPriority } from "./podcast-continuation-priority";
import {
  currentPodcast09ShadowRuntimeState,
  podcast09ShadowListeningStates,
  podcast09ShadowTargetIsAllowed,
  recordPodcast09ShadowAbstention,
  recordPodcast09ShadowComparison,
} from "./podcast-continuation-shadow-runtime";
import {
  planRun as basePlanRun,
  type PlanRunInput,
  type PlanRunResult,
} from "./plan-run-music-identity";
import type { Candidate } from "./types";

export type {
  PlanRunInput,
  PlanRunResult,
  PlanRunTargetResult,
  RunTarget,
} from "./plan-run-music-identity";

/**
 * PODCAST-09 Gate 3 shadow-only seam.
 *
 * The authoritative plan is always produced from the untouched input. For one
 * explicitly allowlisted target, the seam reconstructs the current effective
 * PODCAST-06 order, projects IN_PROGRESS continuation on top of that order and
 * runs a second in-memory plan with PODCAST-06 disabled so the projected order
 * is not re-ranked a second time. The projected plan is discarded and only
 * comparison evidence is retained.
 *
 * No provider/database access or Spotify writes occur here, and the returned
 * plan remains byte-for-byte owned by the existing planner chain.
 */
export function planRun(input: PlanRunInput): PlanRunResult {
  const shadowState = currentPodcast09ShadowRuntimeState();
  if (!shadowState || shadowState.allowedTargetIds.size === 0) {
    return basePlanRun(input);
  }

  const allowlistedTargets = input.targets.filter((target) =>
    podcast09ShadowTargetIsAllowed(target.targetPlaylistId),
  );
  if (allowlistedTargets.length === 0) return basePlanRun(input);

  if (input.targets.length !== 1 || allowlistedTargets.length !== 1) {
    for (const target of allowlistedTargets) {
      recordPodcast09ShadowAbstention({
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        status: "ABSTAIN_MULTI_TARGET_SCOPE",
      });
    }
    return basePlanRun(input);
  }

  const target = allowlistedTargets[0]!;
  const currentPodcastPool = applyPodcast06PlannerRuntimeToCandidates(
    input.pools.podcasts,
  );
  const scopedCurrentPool = filterConfiguredSourceCandidates(
    currentPodcastPool,
    input.sourceIdsByTargetId?.get(target.targetPlaylistId),
  );
  const projection = projectPodcastContinuationPriority({
    candidates: scopedCurrentPool,
    listeningStates: podcast09ShadowListeningStates(),
  });

  const shadowInput: PlanRunInput = {
    ...input,
    pools: {
      ...input.pools,
      podcasts: projection.candidates,
    },
  };

  // The shadow input already contains the effective PODCAST-06 cadence/priority
  // order. Disable only the nested shadow call so that order is not applied a
  // second time. The authoritative call below still uses the real runtime state.
  const podcast06State = currentPodcast06PlannerShadowRuntimeState();
  const projected = podcast06State
    ? runWithPodcast06PlannerShadowRuntimeState(
        {
          ...podcast06State,
          requestedMode: "OFF",
          effectiveMode: "OFF",
          activationReason: "MODE_OFF",
        },
        () => basePlanRun(shadowInput),
      )
    : basePlanRun(shadowInput);

  // Run the authoritative path last so any best-effort evidence owned by lower
  // seams reflects the plan that is actually returned/applied.
  const actual = basePlanRun(input);
  const currentTarget = actual.targets.find(
    (entry) => entry.targetPlaylistId === target.targetPlaylistId,
  );
  const projectedTarget = projected.targets.find(
    (entry) => entry.targetPlaylistId === target.targetPlaylistId,
  );

  if (currentTarget && projectedTarget) {
    recordPodcast09ShadowComparison({
      targetPlaylistId: target.targetPlaylistId,
      targetName: target.name,
      continuationCandidateCount: projection.continuationCandidateCount,
      promotedEpisodeIds: projection.promotedEpisodeIds,
      selectedEpisodeId: projection.selectedEpisodeId,
      movedCount: projection.movedCount,
      currentPoolEpisodeIds: episodeIds(scopedCurrentPool),
      projectedPoolEpisodeIds: episodeIds(projection.candidates),
      currentPlan: currentTarget.result,
      projectedPlan: projectedTarget.result,
    });
  }

  return actual;
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

function episodeIds(candidates: readonly Candidate[]): string[] {
  return candidates.flatMap((candidate) =>
    candidate.type === "PODCAST" && candidate.spotifyEpisodeId
      ? [candidate.spotifyEpisodeId]
      : [],
  );
}
