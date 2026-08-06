import { planPlaylist, type PlannerPools } from "./planner";
import type { PlanResult, PlaylistRules } from "./types";

export interface RunTarget {
  targetPlaylistId: string;
  name: string;
  /** Lower priority is planned first and reserves its content. */
  priority: number;
  rules: PlaylistRules;
}

export interface PlanRunInput {
  /** Candidate pools shared by every target (built from the user's sources). */
  pools: PlannerPools;
  targets: RunTarget[];
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
 * Plans every target playlist of a single run in priority order, threading the
 * set of already-used URIs forward. This is what guarantees that no track and
 * no episode appears in two playlists generated in the same run.
 *
 * Pure function: no Spotify, no database. The orchestration layer builds the
 * pools and persists / applies the returned plans.
 */
export function planRun({ pools, targets }: PlanRunInput): PlanRunResult {
  const ordered = [...targets].sort((a, b) => a.priority - b.priority);
  const reserved = new Set<string>();
  const results: PlanRunTargetResult[] = [];

  for (const target of ordered) {
    const result = planPlaylist({ rules: target.rules, pools, reserved });
    for (const uri of result.usedUris) reserved.add(uri);
    results.push({
      targetPlaylistId: target.targetPlaylistId,
      name: target.name,
      result,
    });
  }

  return { targets: results };
}
