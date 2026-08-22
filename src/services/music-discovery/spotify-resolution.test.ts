import assert from "node:assert/strict";
import test from "node:test";

import type {
  SpotifyCatalogArtistSummary,
  SpotifyCatalogTrackSummary,
} from "@/services/spotify/catalog-search";
import {
  resolveExternalDiscoveryCandidate,
  resolveExternalDiscoveryCandidates,
  type SpotifyDiscoveryResolutionProvider,
} from "./spotify-resolution";

const candidateTrack = {
  candidateKey: "track:nonpoint:everybody-down",
  candidateType: "TRACK" as const,
  artistName: "Nonpoint",
  trackName: "Everybody Down",
};

const candidateArtist = {
  candidateKey: "artist:stick-figure",
  candidateType: "ARTIST" as const,
  artistName: "Stick Figure",
  trackName: null,
};

test("Gate 5E resolves an exact track + artist identity", async () => {
  const resolved = await resolveExternalDiscoveryCandidate(
    provider({ tracks: [track("t1", "Everybody Down", "Nonpoint", "a1", "US-AAA-01")] }),
    candidateTrack,
  );

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.reason, "EXACT_TRACK_ARTIST_MATCH");
  assert.equal(resolved.spotifyTrack?.id, "t1");
  assert.equal(resolved.spotifyArtist?.id, "a1");
});

test("Gate 5E collapses release variants when exact matches share the same ISRC", async () => {
  const resolved = await resolveExternalDiscoveryCandidate(
    provider({
      tracks: [
        track("t1", "Everybody Down", "Nonpoint", "a1", "US-AAA-01"),
        track("t2", "Everybody Down", "Nonpoint", "a1", "US-AAA-01"),
      ],
    }),
    candidateTrack,
  );

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.reason, "EXACT_TRACK_ARTIST_SAME_ISRC_VARIANTS");
  assert.equal(resolved.alternatives.length, 1);
});

test("Gate 5E marks exact title + artist matches ambiguous when recordings differ", async () => {
  const resolved = await resolveExternalDiscoveryCandidate(
    provider({
      tracks: [
        track("t1", "Everybody Down", "Nonpoint", "a1", "US-AAA-01"),
        track("t2", "Everybody Down", "Nonpoint", "a1", "US-BBB-02"),
      ],
    }),
    candidateTrack,
  );

  assert.equal(resolved.status, "AMBIGUOUS");
  assert.equal(resolved.reason, "TRACK_AMBIGUOUS");
  assert.equal(resolved.spotifyTrack, null);
});

test("Gate 5E refuses fuzzy track matches", async () => {
  const resolved = await resolveExternalDiscoveryCandidate(
    provider({ tracks: [track("t1", "Everybody Down - Live", "Nonpoint", "a1", "US-AAA-01")] }),
    candidateTrack,
  );

  assert.equal(resolved.status, "NOT_FOUND");
  assert.equal(resolved.reason, "TRACK_NOT_FOUND");
});

test("Gate 5E resolves one exact artist and chooses a representative track tied to its artist id", async () => {
  const artistRow = artist("a1", "Stick Figure");
  const resolved = await resolveExternalDiscoveryCandidate(
    provider({
      artists: [artistRow],
      tracks: [
        track("wrong", "Other Song", "Stick Figure", "other-id", "US-X-01"),
        track("right", "World on Fire", "Stick Figure", "a1", "US-Y-02"),
      ],
    }),
    candidateArtist,
  );

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.reason, "EXACT_ARTIST_WITH_REPRESENTATIVE_TRACK");
  assert.equal(resolved.spotifyArtist?.id, "a1");
  assert.equal(resolved.spotifyTrack?.id, "right");
});

test("Gate 5E marks duplicate exact artist names ambiguous instead of guessing", async () => {
  const resolved = await resolveExternalDiscoveryCandidate(
    provider({ artists: [artist("a1", "Stick Figure"), artist("a2", "Stick Figure")] }),
    candidateArtist,
  );

  assert.equal(resolved.status, "AMBIGUOUS");
  assert.equal(resolved.reason, "ARTIST_AMBIGUOUS");
  assert.equal(resolved.alternatives.length, 2);
});

test("Gate 5E isolates provider failure per candidate", async () => {
  const throwingProvider: SpotifyDiscoveryResolutionProvider = {
    async searchArtists() {
      throw new Error("spotify unavailable");
    },
    async searchTracks() {
      return [track("t1", "Everybody Down", "Nonpoint", "a1", "US-AAA-01")];
    },
  };

  const batch = await resolveExternalDiscoveryCandidates(throwingProvider, [
    candidateArtist,
    candidateTrack,
  ]);

  assert.equal(batch.failures.length, 1);
  assert.equal(batch.failures[0]?.candidateKey, candidateArtist.candidateKey);
  assert.equal(batch.resolutions.length, 1);
  assert.equal(batch.resolutions[0]?.status, "RESOLVED");
});

function provider(input: {
  artists?: SpotifyCatalogArtistSummary[];
  tracks?: SpotifyCatalogTrackSummary[];
}): SpotifyDiscoveryResolutionProvider {
  return {
    async searchArtists() {
      return input.artists ?? [];
    },
    async searchTracks() {
      return input.tracks ?? [];
    },
  };
}

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
  isrc: string | null,
): SpotifyCatalogTrackSummary {
  return {
    id,
    name,
    uri: `spotify:track:${id}`,
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    isrc,
    artists: [artist(artistId, artistName)],
    albumName: "Album",
  };
}
