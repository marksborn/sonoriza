import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMusic07EligibilityToCandidates,
  music07EligibilityRuntimeSummary,
  offMusic07EligibilityRuntimeState,
  type Music07EligibilityRuntimeState,
} from "./music-exposure-runtime";

const candidates = [
  {
    type: "MUSIC" as const,
    uri: "spotify:track:A",
    title: "A",
    subtitle: "Artist A",
    durationMs: 180000,
    spotifyTrackId: "A",
    primaryArtistId: "artist-a",
    albumId: "album-a",
  },
  {
    type: "MUSIC" as const,
    uri: "spotify:track:B",
    title: "B",
    subtitle: "Artist B",
    durationMs: 180000,
    spotifyTrackId: "B",
    primaryArtistId: "artist-b",
    albumId: "album-b",
  },
];

test("OFF state has no planner influence", () => {
  const state = offMusic07EligibilityRuntimeState();
  const result = applyMusic07EligibilityToCandidates(candidates, state);
  assert.equal(result.length, 2);
  assert.equal(state.exposureCooldownSkippedCount, 0);
  assert.equal(music07EligibilityRuntimeSummary(state).lastPlayedAtWritten, false);
});

test("SHADOW state reports anchors but cannot remove candidates", () => {
  const state = runtimeState({
    effectiveMode: "SHADOW",
    productiveInfluenceAllowed: false,
    blockedTrackIds: new Set(["A"]),
  });
  const result = applyMusic07EligibilityToCandidates(candidates, state);
  assert.equal(result.length, 2);
  assert.equal(state.exposureCooldownSkippedCount, 0);
});

test("ACTIVE scoped state removes exposure-cooldown candidates", () => {
  const state = runtimeState({
    effectiveMode: "ACTIVE",
    productiveInfluenceAllowed: true,
    blockedTrackIds: new Set(["A"]),
  });
  const result = applyMusic07EligibilityToCandidates(candidates, state);
  assert.deepEqual(result.map((row) => row.spotifyTrackId), ["B"]);
  assert.equal(state.exposureCooldownSkippedCount, 1);
});

function runtimeState(
  overrides: Partial<Music07EligibilityRuntimeState>,
): Music07EligibilityRuntimeState {
  return {
    configuredMode: "SHADOW",
    effectiveMode: "SHADOW",
    productiveInfluenceAllowed: false,
    status: "READY_SHADOW",
    projection: null,
    blockedTrackIds: new Set<string>(),
    exposureCooldownSkippedCount: 0,
    diagnostics: {},
    ...overrides,
  };
}
