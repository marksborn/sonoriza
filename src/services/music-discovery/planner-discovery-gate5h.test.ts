import assert from "node:assert/strict";
import test from "node:test";

import {
  planRun,
  type Candidate,
  type PlanRunResult,
  type RunTarget,
} from "@/services/playlist-planner";

import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";
import {
  applyDiscoveryGate5H,
  resolveDiscoveryGate5HPolicy,
} from "./planner-discovery-gate5h";

function music(id: string, durationMs = 180_000): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: `Track ${id}`,
    subtitle: `Artist ${id}`,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    primaryArtistName: `Artist ${id}`,
    albumId: `album-${id}`,
    albumName: `Album ${id}`,
    durationMs,
  };
}

function target(id: string, durationMs = 1_800_000): RunTarget {
  return {
    targetPlaylistId: id,
    name: id,
    priority: 1,
    rules: {
      targetDurationMs: durationMs,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
      maxEpisodesPerProgram: 1,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

function discovery(id: string, score: number): Gate5FResolvedDiscoveryCandidate {
  return {
    candidateKey: `TRACK:${id}`,
    candidate: music(id, 181_000),
    rawScore: score,
    adjustedScore: score,
    historyClass: "NEW_TRACK_KNOWN_ARTIST",
    pathLabel: "Seed → direct",
    resolutionReason: "EXACT_TRACK_ARTIST_MATCH",
    isrc: null,
  };
}

function baselineFor(runTarget: RunTarget, count = 10): PlanRunResult {
  return planRun({
    pools: { music: Array.from({ length: count }, (_, index) => music(`b${index + 1}`)), podcasts: [] },
    targets: [runTarget],
  });
}

test("Gate 5H is fail-closed behind base runtime, master flag and email allowlist", () => {
  assert.equal(
    resolveDiscoveryGate5HPolicy({
      baseDiscoveryEnabled: false,
      userEmail: "user@example.com",
      masterEnabled: "true",
      allowlistedEmails: "user@example.com",
    }).reason,
    "BASE_DISCOVERY_DISABLED",
  );
  assert.equal(
    resolveDiscoveryGate5HPolicy({
      baseDiscoveryEnabled: true,
      userEmail: "user@example.com",
      masterEnabled: "false",
      allowlistedEmails: "user@example.com",
    }).reason,
    "MASTER_DISABLED",
  );
  assert.equal(
    resolveDiscoveryGate5HPolicy({
      baseDiscoveryEnabled: true,
      userEmail: "other@example.com",
      masterEnabled: "true",
      allowlistedEmails: "user@example.com",
    }).reason,
    "USER_NOT_ALLOWLISTED",
  );
  assert.deepEqual(
    resolveDiscoveryGate5HPolicy({
      baseDiscoveryEnabled: true,
      userEmail: " USER@example.com ",
      masterEnabled: "true",
      allowlistedEmails: "user@example.com",
    }),
    { enabled: true, reason: "ENABLED" },
  );
});

test("Gate 5H applies Gate 5G to the final ordered baseline and refreshes final stats", () => {
  const runTarget = target("work");
  const baseline = baselineFor(runTarget, 10);
  baseline.targets[0]!.result.items = [...baseline.targets[0]!.result.items].reverse().map(
    (item, position) => ({ ...item, position }),
  );
  const fifthBefore = baseline.targets[0]!.result.items.filter((item) => item.type === "MUSIC")[4]!;

  const result = applyDiscoveryGate5H({
    baseline,
    targets: [runTarget],
    discoveries: [discovery("new", 80)],
  });

  assert.equal(result.invariantsPassed, true);
  assert.equal(result.applied, true);
  assert.equal(result.selectedDiscoveryCount, 1);
  const finalItems = result.plan.targets[0]!.result.items;
  const fifthAfter = finalItems.filter((item) => item.type === "MUSIC")[4]!;
  assert.equal(fifthAfter.spotifyTrackId, "new");
  assert.notEqual(fifthBefore.spotifyTrackId, fifthAfter.spotifyTrackId);
  assert.equal(result.plan.targets[0]!.result.stats.musicCount, 10);
  assert.equal(
    result.plan.targets[0]!.result.stats.totalDurationMs,
    finalItems.reduce((sum, item) => sum + item.durationMs, 0),
  );
});

test("Gate 5H abstains from KEEP_FILLED targets instead of churning preserved items", () => {
  const runTarget = target("keep");
  const baseline = baselineFor(runTarget, 10);
  const originalUris = baseline.targets[0]!.result.items.map((item) => item.uri);

  const result = applyDiscoveryGate5H({
    baseline,
    targets: [runTarget],
    discoveries: [discovery("new", 80)],
    keepFilledTargetIds: new Set(["keep"]),
  });

  assert.equal(result.applied, false);
  assert.deepEqual(result.skippedKeepFilledTargetIds, ["keep"]);
  assert.deepEqual(
    result.plan.targets[0]!.result.items.map((item) => item.uri),
    originalUris,
  );
});

test("Gate 5H preserves baseline when there is no fifth MUSIC slot", () => {
  const runTarget = target("short", 720_000);
  const baseline = baselineFor(runTarget, 4);
  const originalUris = baseline.targets[0]!.result.items.map((item) => item.uri);
  const result = applyDiscoveryGate5H({
    baseline,
    targets: [runTarget],
    discoveries: [discovery("new", 80)],
  });
  assert.equal(result.applied, false);
  assert.equal(result.selectedDiscoveryCount, 0);
  assert.deepEqual(
    result.plan.targets[0]!.result.items.map((item) => item.uri),
    originalUris,
  );
});
