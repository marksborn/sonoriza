import { planPlaylist, type PlannerPools } from "./planner";
import type { Candidate, PlanResult, PlaylistRules } from "./types";

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
  /** SCHEDULE-01 valid remote items keyed by target id. */
  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;
  /** MUSIC-05 pending inferred skips, scoped to the target that produced them. */
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
 * Plans every target playlist of a single run in priority order, threading the
 * set of already-used URIs forward. This is what guarantees that no track and
 * no episode appears in two playlists generated in the same run.
 *
 * MUSIC-05 filtering is target-scoped here rather than in the shared source
 * reader. A skip inferred in target A must not silently make the same track
 * ineligible for target B.
 *
 * Pure function: no Spotify, no database. The orchestration layer builds the
 * pools and persists / applies the returned plans.
 */
export function planRun({
  pools,
  targets,
  preservedByTargetId,
  blockedMusicTrackIdsByTargetId,
  initialReserved,
}: PlanRunInput): PlanRunResult {
  const ordered = [...targets].sort((a, b) => a.priority - b.priority);
  const reserved = new Set<string>(initialReserved ?? []);
  const results: PlanRunTargetResult[] = [];

  for (const target of ordered) {
    const blockedTrackIds = blockedMusicTrackIdsByTargetId?.get(
      target.targetPlaylistId,
    );
    const targetPools =
      blockedTrackIds && blockedTrackIds.size > 0
        ? {
            ...pools,
            music: pools.music.filter(
              (candidate) =>
                !candidate.spotifyTrackId ||
                !blockedTrackIds.has(candidate.spotifyTrackId),
            ),
          }
        : pools;

    const result = planPlaylist({
      rules: target.rules,
      pools: targetPools,
      reserved,
      preserved: preservedByTargetId?.get(target.targetPlaylistId),
    });
    for (const uri of result.usedUris) reserved.add(uri);
    results.push({
      targetPlaylistId: target.targetPlaylistId,
      name: target.name,
      result,
    });
  }

  return { targets: results };
}
