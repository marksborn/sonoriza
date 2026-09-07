export type PodcastCadenceUnitValue = "DAY" | "WEEK" | "MONTH";
export type PodcastShowPriorityValue = "NORMAL" | "PRIORITY";

export type PodcastShowCadenceConfig = Readonly<{
  cadenceMaxEpisodes: number | null;
  cadenceUnit: PodcastCadenceUnitValue | null;
}>;

export const DEFAULT_PODCAST_SHOW_CADENCE: PodcastShowCadenceConfig =
  Object.freeze({
    cadenceMaxEpisodes: null,
    cadenceUnit: null,
  });

export const DEFAULT_PODCAST_SHOW_PRIORITY: PodcastShowPriorityValue = "NORMAL";

/**
 * PODCAST-06 Gate 1 persistence contract.
 *
 * Cadence is either fully disabled (null/null) or fully configured with a
 * positive episode budget and a civil-calendar unit. A half-configured policy
 * is rejected instead of being interpreted silently.
 */
export function normalizePodcastShowCadence(input: {
  cadenceMaxEpisodes: number | null;
  cadenceUnit: PodcastCadenceUnitValue | null;
}): PodcastShowCadenceConfig {
  const maxEpisodes = input.cadenceMaxEpisodes;
  const unit = input.cadenceUnit;

  if (maxEpisodes === null && unit === null) {
    return DEFAULT_PODCAST_SHOW_CADENCE;
  }

  if (
    !Number.isInteger(maxEpisodes) ||
    Number(maxEpisodes) < 1 ||
    unit === null
  ) {
    throw new Error(
      "Podcast cadence must be disabled (null/null) or use a positive episode budget with DAY, WEEK or MONTH.",
    );
  }

  return Object.freeze({
    cadenceMaxEpisodes: Number(maxEpisodes),
    cadenceUnit: unit,
  });
}

/**
 * Canonical cadence consumption evidence.
 *
 * firstProgressObservedAt is the first factual observation that the episode
 * started. Generation/publication is deliberately not accepted as listening
 * evidence. Returning the same immutable timestamp for the same episode makes
 * the future cadence projection naturally idempotent per episode.
 */
export function podcastCadenceConsumptionObservedAt(input: {
  firstProgressObservedAt: Date | null;
}): Date | null {
  return input.firstProgressObservedAt;
}
