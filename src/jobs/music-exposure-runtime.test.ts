import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMusic07EligibilityToCandidates,
  applyMusic07EligibilityToCandidatesForTarget,
  evaluateMusic07ActiveScope,
  groupMusic07ActiveTrackIdsByTarget,
  music07EligibilityRuntimeSummary,
  offMusic07EligibilityRuntimeState,
  resolveMusic07EligibilityScope,
  selectMusic07ProductiveBlockedTrackIdsByTarget,
  type Music07EligibilityRuntimeState,
} from "./music-exposure-runtime";
import type { MusicExposureEligibilityProjection } from "@/services/music-exposure/eligibility-anchor";

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

test("legacy ACTIVE single-target state keeps existing candidate filter behavior", () => {
  const state = runtimeState({
    configuredMode: "ACTIVE",
    effectiveMode: "ACTIVE",
    productiveInfluenceAllowed: true,
    status: "READY_ACTIVE",
    blockedTrackIds: new Set(["A"]),
    blockedTrackIdsByTargetId: new Map([["target-a", new Set(["A"])]]),
  });
  const result = applyMusic07EligibilityToCandidates(candidates, state);
  assert.deepEqual(result.map((row) => row.spotifyTrackId), ["B"]);
  assert.equal(state.exposureCooldownSkippedCount, 1);
});

test("missing SCOPE is backward-compatible ALLOWLIST and never GLOBAL", () => {
  assert.deepEqual(resolveMusic07EligibilityScope(undefined), {
    scope: "ALLOWLIST",
    explicit: false,
    valid: true,
    raw: null,
  });
  assert.deepEqual(resolveMusic07EligibilityScope("  "), {
    scope: "ALLOWLIST",
    explicit: false,
    valid: true,
    raw: null,
  });
});

test("GLOBAL requires explicit valid SCOPE and invalid values fail closed", () => {
  assert.deepEqual(resolveMusic07EligibilityScope("global"), {
    scope: "GLOBAL",
    explicit: true,
    valid: true,
    raw: "global",
  });
  assert.deepEqual(resolveMusic07EligibilityScope("all"), {
    scope: "ALLOWLIST",
    explicit: true,
    valid: false,
    raw: "all",
  });
});

test("ALLOWLIST ACTIVE retains exactly one allowlisted target", () => {
  const common = {
    userEmail: "owner@example.com",
    allowedEmails: new Set(["owner@example.com"]),
    allowedTargetIds: new Set(["target-a", "target-b"]),
    scopeConfig: resolveMusic07EligibilityScope(undefined),
  };

  assert.deepEqual(
    evaluateMusic07ActiveScope({ ...common, targetPlaylistIds: null }),
    {
      allowed: false,
      status: "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED",
      targetPlaylistIds: [],
      legacySingleTargetFilterAllowed: false,
    },
  );
  assert.deepEqual(
    evaluateMusic07ActiveScope({
      ...common,
      targetPlaylistIds: ["target-a", "target-b"],
    }),
    {
      allowed: false,
      status: "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED",
      targetPlaylistIds: [],
      legacySingleTargetFilterAllowed: false,
    },
  );
  assert.deepEqual(
    evaluateMusic07ActiveScope({ ...common, targetPlaylistIds: ["target-x"] }),
    {
      allowed: false,
      status: "ABSTAIN_TARGET_NOT_ALLOWLISTED",
      targetPlaylistIds: [],
      legacySingleTargetFilterAllowed: false,
    },
  );
  assert.deepEqual(
    evaluateMusic07ActiveScope({ ...common, targetPlaylistIds: ["target-a"] }),
    {
      allowed: true,
      status: "READY_ACTIVE",
      targetPlaylistIds: ["target-a"],
      legacySingleTargetFilterAllowed: true,
    },
  );
});

test("Gate 4 authorizes ACTIVE GLOBAL for an allowlisted user", () => {
  assert.deepEqual(
    evaluateMusic07ActiveScope({
      userEmail: "owner@example.com",
      targetPlaylistIds: ["target-a", "target-b", "target-a"],
      allowedEmails: new Set(["owner@example.com"]),
      allowedTargetIds: new Set(["legacy-only"]),
      scopeConfig: resolveMusic07EligibilityScope("GLOBAL"),
    }),
    {
      allowed: true,
      status: "READY_ACTIVE",
      targetPlaylistIds: ["target-a", "target-b"],
      legacySingleTargetFilterAllowed: false,
    },
  );
});

test("Gate 4 GLOBAL without explicit target scope means all projected targets", () => {
  const decision = evaluateMusic07ActiveScope({
    userEmail: "owner@example.com",
    targetPlaylistIds: null,
    allowedEmails: new Set(["owner@example.com"]),
    allowedTargetIds: new Set(),
    scopeConfig: resolveMusic07EligibilityScope("GLOBAL"),
  });
  assert.deepEqual(decision, {
    allowed: true,
    status: "READY_ACTIVE",
    targetPlaylistIds: [],
    legacySingleTargetFilterAllowed: false,
  });

  const projected = new Map<string, ReadonlySet<string>>([
    ["target-a", new Set(["A"])],
    ["target-b", new Set(["B"])],
  ]);
  const selected = selectMusic07ProductiveBlockedTrackIdsByTarget(
    projected,
    decision,
    "GLOBAL",
  );
  assert.deepEqual([...selected.get("target-a") ?? []], ["A"]);
  assert.deepEqual([...selected.get("target-b") ?? []], ["B"]);
});

test("Gate 4 scoped GLOBAL selects only requested target blocked sets", () => {
  const decision = evaluateMusic07ActiveScope({
    userEmail: "owner@example.com",
    targetPlaylistIds: ["target-b"],
    allowedEmails: new Set(["owner@example.com"]),
    allowedTargetIds: new Set(),
    scopeConfig: resolveMusic07EligibilityScope("GLOBAL"),
  });
  const projected = new Map<string, ReadonlySet<string>>([
    ["target-a", new Set(["A"])],
    ["target-b", new Set(["B"])],
  ]);
  const selected = selectMusic07ProductiveBlockedTrackIdsByTarget(
    projected,
    decision,
    "GLOBAL",
  );
  assert.equal(selected.has("target-a"), false);
  assert.deepEqual([...selected.get("target-b") ?? []], ["B"]);
});

test("ACTIVE requires an allowlisted user", () => {
  assert.deepEqual(
    evaluateMusic07ActiveScope({
      userEmail: "other@example.com",
      targetPlaylistIds: ["target-a"],
      allowedEmails: new Set(["owner@example.com"]),
      allowedTargetIds: new Set(["target-a"]),
    }),
    {
      allowed: false,
      status: "ABSTAIN_USER_NOT_ALLOWLISTED",
      targetPlaylistIds: [],
      legacySingleTargetFilterAllowed: false,
    },
  );
});

test("active anchors are grouped by target without cross-target union", () => {
  const grouped = groupMusic07ActiveTrackIdsByTarget(projection());
  assert.deepEqual([...grouped.get("target-a") ?? []].sort(), ["A", "SHARED"]);
  assert.deepEqual([...grouped.get("target-b") ?? []].sort(), ["B", "SHARED"]);
});

test("target-aware candidate seam blocks only that target's own anchors", () => {
  const state = runtimeState({
    configuredMode: "ACTIVE",
    configuredScope: "GLOBAL",
    scopeExplicit: true,
    effectiveMode: "ACTIVE",
    productiveInfluenceAllowed: true,
    status: "READY_ACTIVE",
    blockedTrackIds: new Set<string>(),
    blockedTrackIdsByTargetId: new Map([
      ["target-a", new Set(["A"])],
      ["target-b", new Set(["B"])],
    ]),
  });

  const targetA = applyMusic07EligibilityToCandidatesForTarget(
    "target-a",
    candidates,
    state,
  );
  const targetB = applyMusic07EligibilityToCandidatesForTarget(
    "target-b",
    candidates,
    state,
  );

  assert.deepEqual(targetA.map((row) => row.spotifyTrackId), ["B"]);
  assert.deepEqual(targetB.map((row) => row.spotifyTrackId), ["A"]);
  assert.equal(state.exposureCooldownSkippedCountByTargetId.get("target-a"), 1);
  assert.equal(state.exposureCooldownSkippedCountByTargetId.get("target-b"), 1);
});

function runtimeState(
  overrides: Partial<Music07EligibilityRuntimeState>,
): Music07EligibilityRuntimeState {
  return {
    configuredMode: "SHADOW",
    configuredScope: "ALLOWLIST",
    scopeExplicit: false,
    effectiveMode: "SHADOW",
    productiveInfluenceAllowed: false,
    status: "READY_SHADOW",
    projection: null,
    blockedTrackIds: new Set<string>(),
    projectedBlockedTrackIdsByTargetId: new Map(),
    blockedTrackIdsByTargetId: new Map(),
    exposureCooldownSkippedCount: 0,
    exposureCooldownSkippedCountByTargetId: new Map(),
    diagnostics: {},
    ...overrides,
  };
}

function projection(): MusicExposureEligibilityProjection {
  const anchorAt = new Date("2026-09-11T10:00:59.110Z");
  const cooldownUntil = new Date("2027-03-11T10:00:59.110Z");
  const makeAnchor = (
    targetPlaylistId: string,
    spotifyTrackId: string,
  ) => ({
    targetPlaylistId,
    targetName: targetPlaylistId,
    spotifyTrackId,
    trackName: spotifyTrackId,
    artistName: "Artist",
    consecutiveUnconfirmedExposureCount: 4,
    threshold: 4,
    anchorAt,
    cooldownUntil,
    source: "SONORIZA_EXPOSURE" as const,
    active: true,
  });
  const activeAnchors = [
    makeAnchor("target-a", "A"),
    makeAnchor("target-a", "SHARED"),
    makeAnchor("target-b", "B"),
    makeAnchor("target-b", "SHARED"),
  ];
  return {
    status: "READY",
    threshold: 4,
    anchors: activeAnchors,
    activeAnchors,
    activeTrackIds: new Set(activeAnchors.map((anchor) => anchor.spotifyTrackId)),
  };
}
