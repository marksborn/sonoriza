export * from "./types";
export { planPlaylist, type PlannerPools, type PlanPlaylistInput } from "./planner";
export {
  planRun,
  type RunTarget,
  type PlanRunInput,
  type PlanRunResult,
  type PlanRunTargetResult,
} from "./plan-run";

import type { ContentType } from "./types";

/**
 * Parses a persisted `sequencePattern` (stored as JSON) into a typed array,
 * tolerating loose input like ["music","podcast"] or shorthand ["m","p"].
 */
export function parseSequencePattern(raw: unknown): ContentType[] {
  if (!Array.isArray(raw)) return [];
  const result: ContentType[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const v = entry.trim().toUpperCase();
    if (v === "MUSIC" || v === "M") result.push("MUSIC");
    else if (v === "PODCAST" || v === "P") result.push("PODCAST");
  }
  return result;
}
