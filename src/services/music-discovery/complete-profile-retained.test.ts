import assert from "node:assert/strict";
import test from "node:test";

import { retainCompleteMusicDiscoveryProfile } from "./complete-profile";
import { buildMusicDiscoveryProfile, type DiscoveryHistoryEvent } from "./profile";

const AS_OF = new Date("2026-08-21T15:00:00.000Z");

function event(
  spotifyTrackId: string,
  artistName: string,
  trackName: string,
  playedAt: string,
): DiscoveryHistoryEvent {
  return {
    source: "SPOTIFY_RECENTLY_PLAYED",
    spotifyTrackId,
    spotifyUri: `spotify:track:${spotifyTrackId}`,
    trackName,
    artistName,
    albumName: `${artistName} Album`,
    playedAt: new Date(playedAt),
    metadata: null,
  };
}

test("COMPLETE runtime retains canonical universes but not redundant derived views", () => {
  const full = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events: [
      event("track-a", "Artist A", "Track A", "2026-08-10T12:00:00.000Z"),
      event("track-a", "Artist A", "Track A", "2026-08-11T12:00:00.000Z"),
      event("track-b", "Artist B", "Track B", "2025-01-01T12:00:00.000Z"),
    ],
    inferredSkips: [],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: null,
    completeUniverse: true,
  });

  const retained = retainCompleteMusicDiscoveryProfile(full);

  assert.equal(retained.universe, "COMPLETE");
  assert.strictEqual(retained.artists, full.topArtistsHistorical);
  assert.strictEqual(retained.tracks, full.topTracksHistorical);
  assert.deepEqual(retained.profile, {
    generatedAt: full.generatedAt,
    heuristics: full.heuristics,
    coverage: full.coverage,
    cooldown: full.cooldown,
  });
  assert.deepEqual(Object.keys(retained.profile).sort(), [
    "cooldown",
    "coverage",
    "generatedAt",
    "heuristics",
  ]);
  assert.equal("topArtists30d" in retained.profile, false);
  assert.equal("topTracksHistorical" in retained.profile, false);
  assert.equal("familiarCandidates" in retained.profile, false);
  assert.equal("rediscoveryCandidates" in retained.profile, false);
});
