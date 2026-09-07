import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMusic07EligibilityToCandidates,
  evaluateMusic07ActiveScope,
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
    configuredMode: "ACTIVE",
    effectiveMode: "ACTIVE",
    productiveInfluenceAllowed: true,
    status: "READY_ACTIVE",
    blockedTrackIds: new Set(["A"]),
  });
  const result = applyMusic07EligibilityToCandidates(candidates, state);
  assert.deepEqual(result.map((row) => row.spotifyTrackId), ["B"]);
  assert.equal(state.exposureCooldownSkippedCount, 1);
});

test("ACTIVE requires exactly one allowlisted target to avoid cross-target leakage", () => {
  const common = {
    userEmail: "owner@example.com",
    allowedEmails: new Set(["owner@example.com"]),
    allowedTargetIds: new Set(["target-a", "target-b"]),
  };

  assert.deepEqual(
    evaluateMusic07ActiveScope({ ...common, targetPlaylistIds: null }),
    { allowed: false, status: "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED" },
  );
  assert.deepEqual(
    evaluateMusic07ActiveScope({
      ...common,
      targetPlaylistIds: ["target-a", "target-b"],
    }),
    { allowed: false, status: "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED" },
  );
  assert.deepEqual(
    evaluateMusic07ActiveScope({ ...common, targetPlaylistIds: ["target-x"] }),
    { allowed: false, status: "ABSTAIN_TARGET_NOT_ALLOWLISTED" },
  );
  assert.deepEqual(
    evaluateMusic07ActiveScope({ ...common, targetPlaylistIds: ["target-a"] }),
    { allowed: true, status: "READY_ACTIVE" },
  );
});

test("ACTIVE requires an allowlisted user", () => {
  assert.deepEqual(
    evaluateMusic07ActiveScope({
      userEmail: "other@example.com",
      targetPlaylistIds: ["target-a"],
      allowedEmails: new Set(["owner@example.com"]),
      allowedTargetIds: new Set(["target-a"]),
    }),
    { allowed: false, status: "ABSTAIN_USER_NOT_ALLOWLISTED" },
  );
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
