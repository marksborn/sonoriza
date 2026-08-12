import { createHash } from "node:crypto";

import { canonicalSpotifyTrackId } from "./music-availability";

export type SpotifyRecentTrackForHistory = {
  id?: string | null;
  uri?: string | null;
  name?: string | null;
  linked_from?: { id?: string | null } | null;
  artists?: Array<{ id?: string | null; name?: string | null }> | null;
  album?: { id?: string | null; name?: string | null } | null;
  external_ids?: { isrc?: string | null } | null;
};

export type SpotifyRecentContextForHistory = {
  type?: string | null;
  uri?: string | null;
};

export type SpotifyListeningEventInput = {
  source: "SPOTIFY_RECENTLY_PLAYED";
  sourceEventKey: string;
  spotifyTrackId: string;
  spotifyUri: string | null;
  trackName: string;
  artistName: string;
  primaryArtistId: string | null;
  albumName: string | null;
  albumId: string | null;
  isrc: string | null;
  playedAt: Date;
  contextType: string | null;
  contextUri: string | null;
};

export function mapSpotifyRecentlyPlayedEvent(input: {
  track: SpotifyRecentTrackForHistory;
  playedAt: Date;
  context?: SpotifyRecentContextForHistory | null;
}): SpotifyListeningEventInput | null {
  const spotifyTrackId = canonicalSpotifyTrackId(input.track);
  const trackName = clean(input.track.name);
  const artistNames = (input.track.artists ?? [])
    .flatMap((artist) => {
      const name = clean(artist.name);
      return name ? [name] : [];
    })
    .join(", ");
  if (!spotifyTrackId || !trackName || !artistNames) return null;

  return {
    source: "SPOTIFY_RECENTLY_PLAYED",
    sourceEventKey: spotifyRecentlyPlayedEventKey({
      spotifyTrackId,
      playedAt: input.playedAt,
      contextUri: clean(input.context?.uri),
    }),
    spotifyTrackId,
    spotifyUri: clean(input.track.uri),
    trackName,
    artistName: artistNames,
    primaryArtistId: clean(input.track.artists?.[0]?.id),
    albumName: clean(input.track.album?.name),
    albumId: clean(input.track.album?.id),
    isrc: clean(input.track.external_ids?.isrc),
    playedAt: input.playedAt,
    contextType: clean(input.context?.type),
    contextUri: clean(input.context?.uri),
  };
}

export function spotifyRecentlyPlayedEventKey(input: {
  spotifyTrackId: string;
  playedAt: Date;
  contextUri?: string | null;
}): string {
  const payload = [
    input.playedAt.toISOString(),
    input.spotifyTrackId.trim(),
    input.contextUri?.trim() ?? "",
  ].join("\0");
  return `spotify:${createHash("sha256").update(payload).digest("hex")}`;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned : null;
}
