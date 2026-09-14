export const PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES = 8;
export const PODCAST07_PLAYBACK_REFRESH_TTL_MS = 60 * 60 * 1000;
export const PODCAST07_PLAYBACK_REFRESH_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const PODCAST07_PLAYBACK_REFRESH_RECENT_PER_SHOW = 2;

export type Podcast07RefreshListeningState = Readonly<{
  spotifyEpisodeId: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  lastObservedAt: Date;
}>;

/**
 * Builds the bounded provider-read set used by PODCAST-07 before cadence.
 *
 * The caller may load canonical rows only for `recentPublishedEpisodeIds()`;
 * this function then applies the factual-state/TTL/recent-window guards and the
 * hard per-generation cap. COMPLETED is deliberately excluded because canonical
 * completion is sticky.
 */
export function selectPodcast07PlaybackRefreshEpisodeIds(input: {
  publishedEpisodeIdsByShow: ReadonlyMap<string, readonly string[]>;
  listeningStates: readonly Podcast07RefreshListeningState[];
  now: Date;
}): string[] {
  const recentPublishedIds = recentPublishedEpisodeIds(
    input.publishedEpisodeIdsByShow,
  );
  if (recentPublishedIds.size === 0) return [];

  const staleBeforeMs = input.now.getTime() - PODCAST07_PLAYBACK_REFRESH_TTL_MS;
  const recentAfterMs =
    input.now.getTime() - PODCAST07_PLAYBACK_REFRESH_RECENT_WINDOW_MS;

  return input.listeningStates
    .filter((entry) => {
      if (!recentPublishedIds.has(entry.spotifyEpisodeId)) return false;
      if (entry.status === "COMPLETED") return false;
      const observedAt = entry.lastObservedAt.getTime();
      return observedAt >= recentAfterMs && observedAt <= staleBeforeMs;
    })
    .sort(
      (a, b) => b.lastObservedAt.getTime() - a.lastObservedAt.getTime(),
    )
    .slice(0, PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES)
    .map((entry) => entry.spotifyEpisodeId);
}

export function recentPublishedEpisodeIds(
  publishedEpisodeIdsByShow: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const result = new Set<string>();
  for (const episodeIds of publishedEpisodeIdsByShow.values()) {
    const uniqueRecent = [...new Set([...episodeIds].reverse())].slice(
      0,
      PODCAST07_PLAYBACK_REFRESH_RECENT_PER_SHOW,
    );
    for (const episodeId of uniqueRecent) result.add(episodeId);
  }
  return result;
}
