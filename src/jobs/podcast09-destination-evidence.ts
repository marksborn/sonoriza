import type { SpotifyTargetPlaylistContentItem } from "@/services/spotify";

/**
 * PODCAST-09 Gate 3.2.
 *
 * Reuses a target playlist state that an upstream workflow already fetched.
 * No provider access happens here. An empty array is valid factual evidence
 * that the destination currently contains no podcast episodes.
 */
export function podcast09DestinationEpisodeIds(
  items: readonly Pick<
    SpotifyTargetPlaylistContentItem,
    "type" | "spotifyEpisodeId"
  >[],
): string[] {
  return items.flatMap((item) =>
    item.type === "PODCAST" && item.spotifyEpisodeId
      ? [item.spotifyEpisodeId]
      : [],
  );
}
