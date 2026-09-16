import type { Candidate, PlaylistRules } from "./types";

export type PodcastFitSelection = Readonly<{
  selected: readonly Candidate[];
  selectedDurationMs: number;
}>;

export type SelectFittingPodcastsInput = Readonly<{
  candidates: readonly Candidate[];
  reservedUris?: Iterable<string>;
  budgetMs: number;
  maxCount: number;
  programCounts?: ReadonlyMap<string, number>;
  rules: PlaylistRules;
}>;

/**
 * Canonical whole-episode fit selector shared by CALENDAR-03 and
 * PLAYBACK-RESERVE-01.
 *
 * The incoming candidate order is authoritative. Duration is only a filter;
 * this helper never re-ranks candidates to find a best fit. Candidate.durationMs
 * is the effective listening duration supplied by podcast ingestion/runtime:
 * NOT_STARTED uses the whole episode while IN_PROGRESS uses only the remaining
 * duration. Episodes are never truncated to fit the available budget.
 */
export function selectFittingPodcastsInCanonicalOrder(
  input: SelectFittingPodcastsInput,
): PodcastFitSelection {
  const budgetMs = Math.max(0, input.budgetMs);
  const maxCount = Math.max(0, Math.trunc(input.maxCount));
  if (budgetMs <= 0 || maxCount <= 0) {
    return Object.freeze({
      selected: Object.freeze([]),
      selectedDurationMs: 0,
    });
  }

  const reserved = new Set(input.reservedUris ?? []);
  const programCounts = new Map(input.programCounts ?? []);
  const strictBlockedPrograms = new Set<string>();
  const selected: Candidate[] = [];
  let selectedDurationMs = 0;

  for (const candidate of input.candidates) {
    if (selected.length >= maxCount) break;
    if (candidate.type !== "PODCAST") continue;
    if (reserved.has(candidate.uri)) continue;

    const programId = candidate.programId?.trim();
    if (!programId) continue;
    if (strictBlockedPrograms.has(programId)) continue;

    const cap = effectivePodcastProgramCap(candidate, input.rules);
    if ((programCounts.get(programId) ?? 0) >= cap) continue;

    const effectiveDurationMs = Math.max(0, candidate.durationMs);
    if (effectiveDurationMs <= 0) continue;

    const remainingBudgetMs = Math.max(0, budgetMs - selectedDurationMs);
    const maxPodcastDurationMs = input.rules.maxPodcastDurationMs ?? null;
    const fitsDestinationCap =
      maxPodcastDurationMs === null ||
      effectiveDurationMs <= Math.max(0, maxPodcastDurationMs);
    const fitsBudget = effectiveDurationMs <= remainingBudgetMs;

    if (!fitsDestinationCap || !fitsBudget) {
      if (candidate.podcastStrictSequence) {
        strictBlockedPrograms.add(programId);
      }
      continue;
    }

    const normalizedCandidate =
      programId === candidate.programId
        ? candidate
        : { ...candidate, programId };

    selected.push(normalizedCandidate);
    selectedDurationMs += effectiveDurationMs;
    reserved.add(candidate.uri);
    programCounts.set(programId, (programCounts.get(programId) ?? 0) + 1);
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    selectedDurationMs,
  });
}

export function effectivePodcastProgramCap(
  candidate: Candidate,
  rules: PlaylistRules,
): number {
  const targetCap = Math.max(1, Math.trunc(rules.maxEpisodesPerProgram || 1));
  const showCap = candidate.podcastMaxEpisodesPerCycle;
  if (!Number.isInteger(showCap) || Number(showCap) < 1) return targetCap;
  return Math.min(targetCap, Number(showCap));
}
