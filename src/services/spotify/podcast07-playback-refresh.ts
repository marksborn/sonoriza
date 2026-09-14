export const PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES = 8;
export const PODCAST07_PLAYBACK_REFRESH_TTL_MS = 60 * 60 * 1000;

export type Podcast07RefreshListeningState = Readonly<{
  spotifyEpisodeId: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  lastObservedAt: Date;
}>;

export type Podcast07PlaybackRefreshPlan = Readonly<{
  selectedEpisodeIds: readonly string[];
  eligibleEpisodeCount: number;
  eligibleShowCount: number;
  selectedShowCount: number;
  skippedByBudgetCount: number;
  selectedByShowId: Readonly<Record<string, readonly string[]>>;
}>;

/**
 * Builds the bounded provider-read set used by PODCAST-07 before cadence.
 *
 * Selection is show-oriented instead of publication-recency-oriented:
 * - every published episode known to Sonoriza may be considered;
 * - COMPLETED rows remain excluded because canonical completion is sticky;
 * - a one-hour TTL prevents re-reading the same unresolved fact too often;
 * - the first pass takes at most one oldest unresolved episode per show, so one
 *   large show cannot starve all others;
 * - any remaining budget is filled by the globally stalest unresolved rows;
 * - provider reads are still hard-capped per generation.
 *
 * Authoritative refresh updates lastObservedAt, so repeated generations rotate
 * through an unresolved backlog instead of repeatedly selecting the same rows.
 */
export function planPodcast07PlaybackRefresh(input: {
  publishedEpisodeIdsByShow: ReadonlyMap<string, readonly string[]>;
  listeningStates: readonly Podcast07RefreshListeningState[];
  now: Date;
}): Podcast07PlaybackRefreshPlan {
  const showByEpisodeId = new Map<string, string>();
  for (const [showId, episodeIds] of input.publishedEpisodeIdsByShow.entries()) {
    for (const episodeId of episodeIds) {
      if (!showByEpisodeId.has(episodeId)) showByEpisodeId.set(episodeId, showId);
    }
  }

  const staleBeforeMs = input.now.getTime() - PODCAST07_PLAYBACK_REFRESH_TTL_MS;
  const eligible = input.listeningStates
    .filter((entry) => {
      if (entry.status === "COMPLETED") return false;
      if (!showByEpisodeId.has(entry.spotifyEpisodeId)) return false;
      return entry.lastObservedAt.getTime() <= staleBeforeMs;
    })
    .map((entry) => ({
      ...entry,
      showId: showByEpisodeId.get(entry.spotifyEpisodeId)!,
    }));

  const byShow = new Map<string, typeof eligible>();
  for (const entry of eligible) {
    const rows = byShow.get(entry.showId) ?? [];
    rows.push(entry);
    byShow.set(entry.showId, rows);
  }
  for (const rows of byShow.values()) {
    rows.sort((a, b) => a.lastObservedAt.getTime() - b.lastObservedAt.getTime());
  }

  const firstPerShow = [...byShow.entries()]
    .map(([showId, rows]) => ({ showId, entry: rows[0]! }))
    .sort((a, b) => {
      const byAge =
        a.entry.lastObservedAt.getTime() - b.entry.lastObservedAt.getTime();
      return byAge !== 0 ? byAge : a.showId.localeCompare(b.showId);
    });

  const selected: Array<(typeof eligible)[number]> = [];
  const selectedIds = new Set<string>();
  for (const candidate of firstPerShow) {
    if (selected.length >= PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES) break;
    selected.push(candidate.entry);
    selectedIds.add(candidate.entry.spotifyEpisodeId);
  }

  if (selected.length < PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES) {
    const remaining = eligible
      .filter((entry) => !selectedIds.has(entry.spotifyEpisodeId))
      .sort((a, b) => {
        const byAge =
          a.lastObservedAt.getTime() - b.lastObservedAt.getTime();
        if (byAge !== 0) return byAge;
        const byShow = a.showId.localeCompare(b.showId);
        return byShow !== 0
          ? byShow
          : a.spotifyEpisodeId.localeCompare(b.spotifyEpisodeId);
      });
    for (const entry of remaining) {
      if (selected.length >= PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES) break;
      selected.push(entry);
      selectedIds.add(entry.spotifyEpisodeId);
    }
  }

  const selectedByShowId: Record<string, string[]> = {};
  for (const entry of selected) {
    (selectedByShowId[entry.showId] ??= []).push(entry.spotifyEpisodeId);
  }

  return {
    selectedEpisodeIds: selected.map((entry) => entry.spotifyEpisodeId),
    eligibleEpisodeCount: eligible.length,
    eligibleShowCount: byShow.size,
    selectedShowCount: Object.keys(selectedByShowId).length,
    skippedByBudgetCount: Math.max(0, eligible.length - selected.length),
    selectedByShowId,
  };
}

export function selectPodcast07PlaybackRefreshEpisodeIds(input: {
  publishedEpisodeIdsByShow: ReadonlyMap<string, readonly string[]>;
  listeningStates: readonly Podcast07RefreshListeningState[];
  now: Date;
}): string[] {
  return [...planPodcast07PlaybackRefresh(input).selectedEpisodeIds];
}
