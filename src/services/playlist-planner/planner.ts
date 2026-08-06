import type {
  Candidate,
  ContentType,
  PlannedItem,
  PlanResult,
  PlaylistRules,
} from "./types";

export interface PlannerPools {
  music: Candidate[];
  podcasts: Candidate[];
}

export interface PlanPlaylistInput {
  rules: PlaylistRules;
  pools: PlannerPools;
  /**
   * URIs already consumed by earlier playlists in the same run. The planner
   * never places these, which is how cross-playlist exclusivity is enforced.
   */
  reserved?: Iterable<string>;
}

const other = (t: ContentType): ContentType =>
  t === "PODCAST" ? "MUSIC" : "PODCAST";

/**
 * Greedy planner.
 *
 * Walks the (cyclic) sequence pattern and, for each slot, places the next
 * eligible candidate of the requested type. Proportion is honoured as a soft
 * per-type duration budget: once a type's budget is spent, its slots fall back
 * to the other type so the playlist still reaches the target duration.
 *
 * Guarantees:
 *  - no URI is placed twice (nor any URI in `reserved`);
 *  - at most `maxEpisodesPerProgram` episodes of the same program;
 *  - the last item may overshoot the target so total duration >= target when
 *    the pools allow it.
 */
export function planPlaylist({
  rules,
  pools,
  reserved,
}: PlanPlaylistInput): PlanResult {
  const pattern: ContentType[] =
    rules.sequencePattern.length > 0 ? rules.sequencePattern : ["MUSIC"];

  const target = Math.max(0, rules.targetDurationMs);
  const podcastPercent = clamp(rules.podcastPercent, 0, 100);
  const podcastBudget = (target * podcastPercent) / 100;
  const musicBudget = target - podcastBudget;

  const poolByType: Record<ContentType, Candidate[]> = {
    MUSIC: pools.music,
    PODCAST: pools.podcasts,
  };

  const used = new Set<string>(reserved ?? []);
  const newlyUsed = new Set<string>();
  const programCounts = new Map<string, number>();

  const items: PlannedItem[] = [];
  let musicDurationMs = 0;
  let podcastDurationMs = 0;
  let unfilledSlots = 0;

  const durationOf = (t: ContentType) =>
    t === "PODCAST" ? podcastDurationMs : musicDurationMs;
  const budgetOf = (t: ContentType) =>
    t === "PODCAST" ? podcastBudget : musicBudget;
  const overBudget = (t: ContentType) => durationOf(t) >= budgetOf(t);

  let patternIdx = 0;
  let stepsSincePlacement = 0;

  while (musicDurationMs + podcastDurationMs < target) {
    const slotType = pattern[patternIdx]!;
    patternIdx = (patternIdx + 1) % pattern.length;

    // Prefer a type that still has budget; break ties toward the slot's type.
    const order: ContentType[] = !overBudget(slotType)
      ? [slotType, other(slotType)]
      : !overBudget(other(slotType))
        ? [other(slotType), slotType]
        : [slotType, other(slotType)];

    const pick = pickFirst(order, poolByType, used, programCounts, rules.maxEpisodesPerProgram);

    if (!pick) {
      unfilledSlots += 1;
      stepsSincePlacement += 1;
      // A full cycle over the pattern with nothing placeable means both pools
      // are exhausted (or fully capped) — stop instead of looping forever.
      if (stepsSincePlacement >= pattern.length) break;
      continue;
    }

    const { candidate } = pick;
    items.push({ ...candidate, position: items.length });
    used.add(candidate.uri);
    newlyUsed.add(candidate.uri);
    if (candidate.type === "PODCAST") {
      podcastDurationMs += candidate.durationMs;
      if (candidate.programId) {
        programCounts.set(
          candidate.programId,
          (programCounts.get(candidate.programId) ?? 0) + 1,
        );
      }
    } else {
      musicDurationMs += candidate.durationMs;
    }
    stepsSincePlacement = 0;
  }

  const totalDurationMs = musicDurationMs + podcastDurationMs;

  return {
    items,
    usedUris: newlyUsed,
    stats: {
      totalDurationMs,
      musicDurationMs,
      podcastDurationMs,
      musicCount: items.filter((i) => i.type === "MUSIC").length,
      podcastCount: items.filter((i) => i.type === "PODCAST").length,
      unfilledSlots,
      poolExhausted: totalDurationMs < target,
    },
  };
}

function pickFirst(
  order: ContentType[],
  poolByType: Record<ContentType, Candidate[]>,
  used: Set<string>,
  programCounts: Map<string, number>,
  maxEpisodesPerProgram: number,
): { candidate: Candidate } | null {
  for (const type of order) {
    const candidate = pickCandidate(
      poolByType[type],
      used,
      programCounts,
      maxEpisodesPerProgram,
    );
    if (candidate) return { candidate };
  }
  return null;
}

function pickCandidate(
  pool: Candidate[],
  used: Set<string>,
  programCounts: Map<string, number>,
  maxEpisodesPerProgram: number,
): Candidate | null {
  for (const candidate of pool) {
    if (used.has(candidate.uri)) continue;
    if (candidate.type === "PODCAST" && candidate.programId) {
      const count = programCounts.get(candidate.programId) ?? 0;
      if (count >= maxEpisodesPerProgram) continue;
    }
    return candidate;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
