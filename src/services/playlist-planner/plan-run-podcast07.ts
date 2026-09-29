import {
  applyPodcast07PlannerRuntimeToCandidates,
  capturePodcast07PlannedItems,
} from "@/services/spotify/podcast-07-runtime";

import {
  planRun as basePlanRun,
  type PlanRunInput,
  type PlanRunResult,
} from "./plan-run-podcast09";

export type {
  PlanRunInput,
  PlanRunResult,
  PlanRunTargetResult,
  RunTarget,
} from "./plan-run-podcast09";

/**
 * PODCAST-07 Gate 7 remains the outermost podcast policy seam.
 *
 * Effective SAVED_EPISODES default cadence is projected/applied first. The
 * PODCAST-09 Gate 3 wrapper then observes the already-resolved pool in shadow,
 * while PODCAST-06 remains authoritative for explicit per-show cadence and
 * priority inside the existing planner chain. PODCAST-09 never changes the
 * returned plan in Gate 3.
 */
export function planRun(input: PlanRunInput): PlanRunResult {
  const podcasts = applyPodcast07PlannerRuntimeToCandidates(input.pools.podcasts);
  const result = basePlanRun({
    ...input,
    pools: {
      ...input.pools,
      podcasts,
    },
  });
  capturePodcast07PlannedItems(
    result.targets.flatMap((target) => target.result.items),
  );
  return result;
}
