import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSpotifyTrackId,
  readPlayableMusicCandidate,
} from "./music-availability";

const base = {
  id: "ok",
  uri: "spotify:track:ok",
  name: "Playable",
  duration_ms: 180_000,
  type: "track",
  is_local: false,
  artists: [
    { id: "artist-primary", name: "Primary Artist" },
    { id: "artist-featured", name: "Featured Artist" },
  ],
  album: { id: "album-ok", name: "Album" },
};

test("normal playable track becomes a music candidate with canonical and diversity identities", () => {
  const result = readPlayableMusicCandidate({ ...base, is_playable: true });
  assert.equal(result.unavailable, false);
  assert.equal(result.candidate?.uri, base.uri);
  assert.equal(result.candidate?.spotifyTrackId, "ok");
  assert.equal(result.candidate?.primaryArtistId, "artist-primary");
  assert.equal(result.candidate?.primaryArtistName, "Primary Artist");
  assert.equal(result.candidate?.albumId, "album-ok");
  assert.equal(result.candidate?.albumName, "Album");
  assert.equal(result.candidate?.subtitle, "Primary Artist, Featured Artist");
});

test("MUSIC-04 uses artists[0].id as primary artist and never a featured artist id", () => {
  const result = readPlayableMusicCandidate({
    ...base,
    artists: [
      { id: "artist-b", name: "Artist B" },
      { id: "shared-feature", name: "Shared Feature" },
    ],
  });
  assert.equal(result.candidate?.primaryArtistId, "artist-b");
  assert.notEqual(result.candidate?.primaryArtistId, "shared-feature");
});

test("missing artist/album ids remain missing instead of falling back to names", () => {
  const result = readPlayableMusicCandidate({
    ...base,
    artists: [{ name: "Name Only" }],
    album: { name: "Album Name Only" },
  });
  assert.equal(result.candidate?.primaryArtistId, undefined);
  assert.equal(result.candidate?.albumId, undefined);
  assert.equal(result.candidate?.primaryArtistName, "Name Only");
  assert.equal(result.candidate?.albumName, "Album Name Only");
});

test("linked_from id wins over market-specific replacement id", () => {
  assert.equal(
    canonicalSpotifyTrackId({ id: "replacement", linked_from: { id: "original" } }),
    "original",
  );
  const result = readPlayableMusicCandidate({
    ...base,
    id: "replacement",
    linked_from: { id: "original" },
  });
  assert.equal(result.candidate?.spotifyTrackId, "original");
});

test("is_playable=false is explicitly unavailable", () => {
  const result = readPlayableMusicCandidate({ ...base, is_playable: false });
  assert.equal(result.candidate, null);
  assert.equal(result.unavailable, true);
});

test("any Spotify restriction excludes the track, including future reasons", () => {
  const result = readPlayableMusicCandidate({
    ...base,
    is_playable: true,
    restrictions: { reason: "future-policy" },
  });
  assert.equal(result.candidate, null);
  assert.equal(result.unavailable, true);
  assert.equal(result.restrictionReason, "future-policy");
});

test("local track stays excluded without being counted as provider unavailability", () => {
  const result = readPlayableMusicCandidate({ ...base, is_local: true });
  assert.equal(result.candidate, null);
  assert.equal(result.unavailable, false);
});

test("missing is_playable without a restriction does not invent unavailability", () => {
  const result = readPlayableMusicCandidate(base);
  assert.equal(result.unavailable, false);
  assert.equal(result.candidate?.uri, base.uri);
});
