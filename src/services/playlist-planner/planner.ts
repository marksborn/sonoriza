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

const MIX_QUALITY_TOLERANCE_POINTS = 10;

const other = (t: ContentType): ContentType =>
  t === "PODCAST" ? "MUSIC" : "PODCAST";

/**
 * Greedy planner.
 *
 * Walks the (cyclic) sequence pattern and, for each slot, places the next
 * eligible candidate of the requested type. Proportion is honoured as a soft
 * per-type duration budget: once a type's budget is spent, its slots fall back
 * to the other type so the playlist can still reach the target duration.
 *
 * The result now makes any fallback visible through mix-quality metrics. This
 * means the planner can still produce the best available plan, while CONFIG-04
 * can refuse a first real run when that plan materially differs from the rule.
 *
 * Guarantees:
 *  - no URI is placed twice (nor any URI in `reserved`);
 *  - at most `maxEpisodesPerProgram` episodes of the same program;
 *  - podcast candidates without a trustworthy program identity are excluded;
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

  const eligiblePodcasts: Candidate[] = [];
  let podcastIdentityMissingCount = 0;

  for (const candidate of pools.podcasts) {
    const programId = candidate.programId?.trim();
    if (!programId) {
      podcastIdentityMissingCount += 1;
      continue;
    }

    eligiblePodcasts.push(
      programId === candidate.programId
        ? candidate
        : { ...candidate, programId },
    );
  }

  const poolByType: Record<ContentType, Candidate[]> = {
    MUSIC: pools.music,
    PODCAST: eligiblePodcasts,
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

    const pick = pickFirst(
      order,
      poolByType,
      used,
      programCounts,
      rules.maxEpisodesPerProgram,
    );

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
      podcastDurationMs += Math.max(0, candidate.durationMs);
      const programId = candidate.programId!;
      programCounts.set(
        programId,
        (programCounts.get(programId) ?? 0) + 1,
      );
    } else {
      musicDurationMs += Math.max(0, candidate.durationMs);
    }
    stepsSincePlacement = 0;
  }

  const totalDurationMs = musicDurationMs + podcastDurationMs;
  const poolExhausted = totalDurationMs < target;
  const actualPodcastPercent =
    totalDurationMs > 0
      ? round1((podcastDurationMs / totalDurationMs) * 100)
      : target === 0
        ? podcastPercent
        : 0;
  const mixDeviationPoints = round1(
    Math.abs(actualPodcastPercent - podcastPercent),
  );
  const podcastShortfallMs = Math.max(0, podcastBudget - podcastDurationMs);
  const musicShortfallMs = Math.max(0, musicBudget - musicDurationMs);
  const mixQualityPassed =
    target === 0 ||
    (!poolExhausted && mixDeviationPoints <= MIX_QUALITY_TOLERANCE_POINTS);

  return {
    items,
    usedUris: newlyUsed,
    stats: {
      totalDurationMs,
      musicDurationMs,
      podcastDurationMs,
      musicCount: items.filter((i) => i.type === "MUSIC").length,
      podcastCount: items.filter((i) => i.type === "PODCAST").length,
      actualPodcastPercent,
      requestedPodcastPercent: podcastPercent,
      podcastShortfallMs,
      musicShortfallMs,
      mixDeviationPoints,
      mixQualityPassed,
      unfilledSlots,
      poolExhausted,
      podcastIdentityMissingCount,
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
    if (candidate.durationMs <= 0) continue;
    if (candidate.type === "PODCAST") {
      if (!candidate.programId) continue;
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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
