import {
  applyPodcast07PlannerRuntimeToCandidates,
  capturePodcast07PlannedItems,
} from "@/services/spotify/podcast-07-runtime";

import {
  planRun as basePlanRun,
  type PlanRunInput,
  type PlanRunResult,
} from "./plan-run-calendar03";

export type {
  PlanRunInput,
  PlanRunResult,
  PlanRunTargetResult,
  RunTarget,
} from "./plan-run-calendar03";

/**
 * PODCAST-07 Gate 7 is intentionally the outermost podcast policy seam.
 *
 * Effective SAVED_EPISODES default cadence is projected/applied first. The
 * existing PODCAST-06 seam then remains authoritative for explicit per-show
 * cadence and priority, followed by CALENDAR-03 and every pre-existing planner
 * rule. OFF/SHADOW/abstention preserve the incoming pool byte-for-byte.
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
