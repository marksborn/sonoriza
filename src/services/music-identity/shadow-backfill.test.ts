import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShadowBackfillCandidates,
  type ShadowBackfillObservation,
} from "./shadow-backfill";

const NOW = new Date("2026-09-19T12:00:00.000Z");

function observation(
  overrides: Partial<ShadowBackfillObservation> = {},
): ShadowBackfillObservation {
  return {
    source: "SPOTIFY_LISTENING_EVENT",
    observedAt: NOW,
    spotifyTrackId: "track-1",
    spotifyUri: "spotify:track:track-1",
    trackName: "Track One",
    primaryArtistId: "artist-1",
    primaryArtistName: "Artist One",
    albumId: "album-1",
    albumName: "Album One",
    isrc: null,
    trackMbid: null,
    ...overrides,
  };
}

test("incomplete provider metadata is skipped instead of invented", () => {
  const result = buildShadowBackfillCandidates([
    observation({ primaryArtistId: null }),
  ]);

  assert.equal(result.distinctSpotifyTracks, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skippedIncompleteTracks, 1);
  assert.equal(result.skippedConflictTracks, 0);
});

test("liked-track metadata wins as display evidence without changing provider key", () => {
  const result = buildShadowBackfillCandidates([
    observation({
      source: "SPOTIFY_LISTENING_EVENT",
      observedAt: new Date("2026-09-19T13:00:00.000Z"),
      trackName: "Event Display",
      primaryArtistName: "Event Artist Display",
    }),
    observation({
      source: "LIKED_TRACK_PREFERENCE",
      observedAt: new Date("2026-09-18T13:00:00.000Z"),
      trackName: "Liked Display",
      primaryArtistName: "Liked Artist Display",
    }),
  ]);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.spotifyTrackId, "track-1");
  assert.equal(result.candidates[0]?.trackName, "Liked Display");
  assert.equal(result.candidates[0]?.primaryArtistName, "Liked Artist Display");
  assert.equal(result.candidates[0]?.selectedSource, "LIKED_TRACK_PREFERENCE");
});

test("conflicting exact-provider artist observations fail closed", () => {
  const result = buildShadowBackfillCandidates([
    observation(),
    observation({ primaryArtistId: "artist-2" }),
  ]);

  assert.equal(result.candidates.length, 0);
  assert.equal(result.skippedConflictTracks, 1);
});

test("conflicting exact-provider album observations fail closed", () => {
  const result = buildShadowBackfillCandidates([
    observation(),
    observation({ albumId: "album-2", albumName: "Album Two" }),
  ]);

  assert.equal(result.candidates.length, 0);
  assert.equal(result.skippedConflictTracks, 1);
});

test("conflicting ISRC evidence is not used to force a merge", () => {
  const result = buildShadowBackfillCandidates([
    observation({ isrc: "BR-ABC-26-00001" }),
    observation({ isrc: "US-XYZ-26-00002" }),
  ]);

  assert.equal(result.candidates.length, 0);
  assert.equal(result.skippedConflictTracks, 1);
});

test("one normalized ISRC is retained only as evidence", () => {
  const result = buildShadowBackfillCandidates([
    observation({ isrc: "br-abc-26-00001" }),
    observation({ isrc: "BRABC2600001" }),
  ]);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.isrc, "BRABC2600001");
});

test("different Spotify track IDs remain different singleton candidates even with the same ISRC", () => {
  const result = buildShadowBackfillCandidates([
    observation({ spotifyTrackId: "track-1", isrc: "BRABC2600001" }),
    observation({
      spotifyTrackId: "track-2",
      spotifyUri: "spotify:track:track-2",
      trackName: "Track Two",
      isrc: "BRABC2600001",
    }),
  ]);

  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.spotifyTrackId),
    ["track-1", "track-2"],
  );
});
