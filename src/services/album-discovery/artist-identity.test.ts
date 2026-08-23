import assert from "node:assert/strict";
import test from "node:test";

import type {
  SpotifyCatalogArtistSummary,
  SpotifyCatalogTrackSummary,
} from "@/services/spotify/catalog-search";
import {
  resolveExternalDiscoveryCandidate,
  type SpotifyDiscoveryResolutionProvider,
} from "@/services/music-discovery/spotify-resolution";

import { buildHistoricalArtistIdentityEvidence } from "./artist-identity";

test("Gate 1B exposes one historical primaryArtistId as strong identity evidence", () => {
  const evidence = buildHistoricalArtistIdentityEvidence([
    { primaryArtistId: "artist-1", eventCount: 12 },
    { primaryArtistId: " artist-1 ", eventCount: 8 },
    { primaryArtistId: null, eventCount: 99 },
  ]);

  assert.equal(evidence.status, "UNIQUE");
  assert.equal(evidence.primaryArtistId, "artist-1");
  assert.equal(evidence.identifiedEventCount, 20);
  assert.equal(evidence.distinctPrimaryArtistIds, 1);
});

test("Gate 1B refuses historical artist identity when canonical evidence conflicts", () => {
  const evidence = buildHistoricalArtistIdentityEvidence([
    { primaryArtistId: "artist-1", eventCount: 50 },
    { primaryArtistId: "artist-2", eventCount: 1 },
  ]);

  assert.equal(evidence.status, "CONFLICT");
  assert.equal(evidence.primaryArtistId, null);
  assert.equal(evidence.distinctPrimaryArtistIds, 2);
});

test("Gate 1B disambiguates same-name Spotify artists only with the preferred historical id", async () => {
  const resolved = await resolveExternalDiscoveryCandidate(
    provider({
      artists: [artist("wrong-id", "Incubus"), artist("right-id", "Incubus")],
      tracks: [track("track-1", "Drive", "Incubus", "right-id")],
    }),
    {
      candidateKey: "album-artist:incubus",
      candidateType: "ARTIST",
      artistName: "Incubus",
      trackName: null,
      preferredSpotifyArtistId: "right-id",
    },
  );

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.reason, "PREFERRED_SPOTIFY_ARTIST_ID_MATCH");
  assert.equal(resolved.spotifyArtist?.id, "right-id");
  assert.equal(resolved.spotifyTrack?.id, "track-1");
  assert.deepEqual(
    resolved.alternatives.map((row) => row.id),
    ["wrong-id"],
  );
});

test("Gate 1B keeps abstaining when preferred historical id conflicts with Spotify results", async () => {
  const resolved = await resolveExternalDiscoveryCandidate(
    provider({ artists: [artist("other-id", "Chevelle")] }),
    {
      candidateKey: "album-artist:chevelle",
      candidateType: "ARTIST",
      artistName: "Chevelle",
      trackName: null,
      preferredSpotifyArtistId: "historical-id",
    },
  );

  assert.equal(resolved.status, "AMBIGUOUS");
  assert.equal(resolved.reason, "ARTIST_ID_CONFLICT");
  assert.equal(resolved.spotifyArtist, null);
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
): SpotifyCatalogTrackSummary {
  return {
    id,
    name,
    uri: `spotify:track:${id}`,
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    isrc: "US-TEST-01",
    artists: [artist(artistId, artistName)],
    albumId: "album-1",
    albumName: "Album",
    durationMs: 180_000,
  };
}
