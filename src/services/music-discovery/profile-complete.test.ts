import assert from "node:assert/strict";
import test from "node:test";

import { buildMusicDiscoveryProfile } from "./profile";

const AS_OF = new Date("2026-08-20T20:00:00.000Z");

test("completeUniverse returns every canonical artist/track beyond the diagnostic top-100 cap", () => {
  const events = Array.from({ length: 150 }, (_, index) => ({
    source: "SPOTIFY_RECENTLY_PLAYED" as const,
    spotifyTrackId: `track-${String(index).padStart(3, "0")}`,
    spotifyUri: `spotify:track:track-${String(index).padStart(3, "0")}`,
    trackName: `Track ${index}`,
    artistName: `Artist ${index}`,
    albumName: `Album ${index}`,
    playedAt: new Date(AS_OF.getTime() - (index + 400) * 24 * 60 * 60 * 1_000),
    metadata: null,
  }));

  const profile = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: null,
    completeUniverse: true,
  });

  assert.equal(profile.topArtistsHistorical.length, 150);
  assert.equal(profile.topTracksHistorical.length, 150);
  assert.deepEqual(
    new Set(profile.topTracksHistorical.map((track) => track.spotifyTrackId)).size,
    150,
  );
});

test("ordinary ranked views keep the existing topN validation contract", () => {
  assert.throws(
    () =>
      buildMusicDiscoveryProfile({
        asOf: AS_OF,
        events: [],
        inferredSkips: [],
        trackStates: [],
        playbackPolicy: null,
        lastFmValidFrom: null,
        topN: 101,
      }),
    /topN must be an integer between 1 and 100/,
  );
});