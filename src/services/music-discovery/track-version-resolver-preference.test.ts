import assert from "node:assert/strict";
import test from "node:test";

import type {
  SpotifyCatalogArtistSummary,
  SpotifyCatalogTrackSummary,
} from "@/services/spotify/catalog-search";
import {
  chooseRepresentativeTrackByVersion,
  resolveExternalDiscoveryCandidate,
  type SpotifyDiscoveryResolutionProvider,
} from "./spotify-resolution";

test("MUSIC-VERSION-01 Gate 2 prefers studio over an earlier live representative without another Spotify call", async () => {
  const artistRow = artist("a1", "Example Artist");
  const calls: string[] = [];
  const provider: SpotifyDiscoveryResolutionProvider = {
    async searchArtists(name) {
      calls.push(`artist:${name}`);
      return [artistRow];
    },
    async searchTracks(input) {
      calls.push(`track:${input.artistName}`);
      return [
        track("live", "Main Song - Live at Wembley", "Example Artist", "a1", "Live at Wembley"),
        track("studio", "Main Song", "Example Artist", "a1", "Studio Album"),
      ];
    },
  };

  const resolved = await resolveExternalDiscoveryCandidate(provider, {
    candidateKey: "artist:example",
    candidateType: "ARTIST",
    artistName: "Example Artist",
    trackName: null,
  });

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.spotifyTrack?.id, "studio");
  assert.deepEqual(calls, ["artist:Example Artist", "track:Example Artist"]);
});

test("MUSIC-VERSION-01 Gate 2 keeps live as fallback when every canonical track is live", () => {
  const selected = chooseRepresentativeTrackByVersion(
    [
      track("wrong", "Studio Song", "Example Artist", "other-id", "Album"),
      track("live-1", "Song - Live", "Example Artist", "a1", "Live Album"),
      track("live-2", "Another Song (Live at Home)", "Example Artist", "a1", "Live Album"),
    ],
    "a1",
  );

  assert.equal(selected?.id, "live-1");
});

test("MUSIC-VERSION-01 Gate 2 treats Live Forever as standard rather than a live recording", () => {
  const selected = chooseRepresentativeTrackByVersion(
    [
      track("live-recording", "Song - Live", "Example Artist", "a1", "Concert"),
      track("live-forever", "Live Forever", "Example Artist", "a1", "Definitely Maybe"),
    ],
    "a1",
  );

  assert.equal(selected?.id, "live-forever");
});

test("MUSIC-VERSION-01 Gate 2 preserves Spotify order within the same version class", () => {
  const selected = chooseRepresentativeTrackByVersion(
    [
      track("studio-first", "Song One", "Example Artist", "a1", "Album One"),
      track("studio-second", "Song Two", "Example Artist", "a1", "Album Two"),
    ],
    "a1",
  );

  assert.equal(selected?.id, "studio-first");
});

function artist(id: string, name: string): SpotifyCatalogArtistSummary {
  return {
    id,
    name,
    uri: `spotify:artist:${id}`,
    spotifyUrl: `https://open.spotify.com/artist/${id}`,
  };
}

function track(
  id: string,
  name: string,
  artistName: string,
  artistId: string,
  albumName: string,
): SpotifyCatalogTrackSummary {
  return {
    id,
    name,
    uri: `spotify:track:${id}`,
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    isrc: `ISRC-${id}`,
    artists: [artist(artistId, artistName)],
    albumId: `album:${id}`,
    albumName,
    durationMs: 180_000,
  };
}
