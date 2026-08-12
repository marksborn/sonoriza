import assert from "node:assert/strict";
import test from "node:test";

import {
  mapSpotifyRecentlyPlayedEvent,
  spotifyRecentlyPlayedEventKey,
} from "./listening-events";

test("maps Spotify Recently Played metadata into an individual history event", () => {
  const playedAt = new Date("2026-08-12T20:00:00.000Z");
  const event = mapSpotifyRecentlyPlayedEvent({
    playedAt,
    context: { type: "playlist", uri: "spotify:playlist:car" },
    track: {
      id: "replacement",
      uri: "spotify:track:replacement",
      name: "Track",
      linked_from: { id: "original" },
      artists: [
        { id: "artist-1", name: "Artist One" },
        { id: "artist-2", name: "Artist Two" },
      ],
      album: { id: "album-1", name: "Album" },
      external_ids: { isrc: "BRABC1234567" },
    },
  });

  assert.ok(event);
  assert.equal(event.spotifyTrackId, "original");
  assert.equal(event.spotifyUri, "spotify:track:replacement");
  assert.equal(event.trackName, "Track");
  assert.equal(event.artistName, "Artist One, Artist Two");
  assert.equal(event.primaryArtistId, "artist-1");
  assert.equal(event.albumId, "album-1");
  assert.equal(event.albumName, "Album");
  assert.equal(event.isrc, "BRABC1234567");
  assert.equal(event.contextType, "playlist");
  assert.equal(event.contextUri, "spotify:playlist:car");
  assert.equal(event.source, "SPOTIFY_RECENTLY_PLAYED");
  assert.match(event.sourceEventKey, /^spotify:[a-f0-9]{64}$/);
});

test("Spotify event key is deterministic for the same provider event", () => {
  const input = {
    spotifyTrackId: "track-1",
    playedAt: new Date("2026-08-12T20:00:00.000Z"),
    contextUri: "spotify:playlist:car",
  };
  assert.equal(
    spotifyRecentlyPlayedEventKey(input),
    spotifyRecentlyPlayedEventKey(input),
  );
});

test("rejects event rows without stable track identity or human-readable metadata", () => {
  assert.equal(
    mapSpotifyRecentlyPlayedEvent({
      playedAt: new Date("2026-08-12T20:00:00.000Z"),
      track: { name: "Track", artists: [{ name: "Artist" }] },
    }),
    null,
  );
  assert.equal(
    mapSpotifyRecentlyPlayedEvent({
      playedAt: new Date("2026-08-12T20:00:00.000Z"),
      track: { id: "track", name: "Track", artists: [] },
    }),
    null,
  );
});
