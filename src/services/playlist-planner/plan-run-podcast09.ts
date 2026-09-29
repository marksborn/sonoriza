import {
  applyPodcast06PlannerRuntimeToCandidates,
  capturePodcast06PlannerShadow,
  currentPodcast06PlannerShadowRuntimeState,
  runWithPodcast06PlannerShadowRuntimeState,
} from "./podcast-cadence-shadow-runtime";
import { projectPodcastContinuationPriority } from "./podcast-continuation-priority";
import {
  currentPodcast09ShadowRuntimeState,
  podcast09ShadowCurrentDestinationEpisodeIds,
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
 * PODCAST-09 Gate 4 controlled continuation seam.
 *
 * OFF delegates exactly. SHADOW preserves the Gate 3 behavior: compare the
 * destination-local continuation projection and return the existing authoritative
 * plan. ACTIVE is prepared upstream only for an exact allowlisted single-target
 * simulation; in that mode the projected plan becomes authoritative for the
 * simulation while Spotify writes remain impossible by the generation contract.
 *
 * Missing destination evidence and multi-target scope still abstain. PODCAST-06
 * remains the cadence/priority authority: its effective projection is applied
 * before continuation, then disabled only inside the projected planner pass so
 * the already-resolved order is not applied twice.
 */
export function planRun(input: PlanRunInput): PlanRunResult {
  const shadowState = currentPodcast09ShadowRuntimeState();
  if (!shadowState || shadowState.effectiveMode === "OFF") {
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
  const currentDestinationEpisodeIds =
    podcast09ShadowCurrentDestinationEpisodeIds(target.targetPlaylistId);
  if (!currentDestinationEpisodeIds) {
    recordPodcast09ShadowAbstention({
      targetPlaylistId: target.targetPlaylistId,
      targetName: target.name,
      status: "ABSTAIN_NO_DESTINATION_EVIDENCE",
    });
    return basePlanRun(input);
  }

  const currentPodcastPool = applyPodcast06PlannerRuntimeToCandidates(
    input.pools.podcasts,
  );
  const scopedCurrentPool = filterConfiguredSourceCandidates(
    currentPodcastPool,
    input.sourceIdsByTargetId?.get(target.targetPlaylistId),
  );
  const projection = projectPodcastContinuationPriority({
    candidates: scopedCurrentPool,
    currentDestinationEpisodeIds,
  });

  const shadowInput: PlanRunInput = {
    ...input,
    pools: {
      ...input.pools,
      podcasts: projection.candidates,
    },
  };

  const podcast06State = currentPodcast06PlannerShadowRuntimeState();
  const runProjected = () =>
    podcast06State
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

  let actual: PlanRunResult;
  let projected: PlanRunResult;

  if (shadowState.effectiveMode === "ACTIVE") {
    // Baseline first for comparison. The projected call runs last so lower
    // planner seams reflect the plan actually returned by this ACTIVE simulation.
    actual = basePlanRun(input);
    projected = runProjected();

    if (podcast06State) {
      capturePodcast06PlannerShadow({
        candidates: input.pools.podcasts,
        plannedItems: projected.targets.flatMap((entry) => entry.result.items),
      });
    }
  } else {
    // SHADOW keeps legacy behavior authoritative and runs it last so lower seam
    // evidence matches the plan that is actually returned/applied.
    projected = runProjected();
    actual = basePlanRun(input);
  }

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
      currentDestinationEpisodeIds,
      continuationCandidateCount: projection.continuationCandidateCount,
      promotedEpisodeIds: projection.promotedEpisodeIds,
      selectedEpisodeId: projection.selectedEpisodeId,
      movedCount: projection.movedCount,
      currentPoolEpisodeIds: episodeIds(scopedCurrentPool),
      projectedPoolEpisodeIds: episodeIds(projection.candidates),
      currentPlan: currentTarget.result,
      projectedPlan: projectedTarget.result,
      plannerInfluence: shadowState.effectiveMode === "ACTIVE",
    });
  }

  return shadowState.effectiveMode === "ACTIVE" ? projected : actual;
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
