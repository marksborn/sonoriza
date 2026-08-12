import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type RunTarget } from "./plan-run";
import type { Candidate } from "./types";

function music(id: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    durationMs: 60_000,
  };
}

function target(targetPlaylistId: string, priority: number): RunTarget {
  return {
    targetPlaylistId,
    name: targetPlaylistId,
    priority,
    rules: {
      targetDurationMs: 60_000,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 1,
    },
  };
}

test("MUSIC-05 blocks a pending inferred skip only in the target that produced it", () => {
  const result = planRun({
    pools: { music: [music("B"), music("C")], podcasts: [] },
    targets: [target("target-a", 0), target("target-b", 1)],
    blockedMusicTrackIdsByTargetId: new Map([
      ["target-a", new Set(["B"])],
    ]),
  });

  assert.equal(result.targets[0]?.result.items[0]?.spotifyTrackId, "C");
  assert.equal(result.targets[1]?.result.items[0]?.spotifyTrackId, "B");
});

test("MUSIC-05 leaves planning unchanged when no target has pending signals", () => {
  const result = planRun({
    pools: { music: [music("A"), music("B")], podcasts: [] },
    targets: [target("target-a", 0)],
  });

  assert.equal(result.targets[0]?.result.items[0]?.spotifyTrackId, "A");
});
