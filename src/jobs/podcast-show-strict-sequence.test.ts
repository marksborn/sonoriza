import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type Candidate, type RunTarget } from "@/services/playlist-planner";

function episode(id: string, durationMs: number): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    spotifyEpisodeId: id,
    type: "PODCAST",
    title: id,
    programId: "show-a",
    durationMs,
    podcastMaxEpisodesPerCycle: 2,
    podcastStrictSequence: true,
  };
}

function target(durationMs: number): RunTarget {
  return {
    targetPlaylistId: "target-a",
    name: "Target A",
    priority: 0,
    rules: {
      targetDurationMs: durationMs,
      compositionMode: "PROPORTION",
      podcastPercent: 100,
      sequencePattern: ["PODCAST"],
      maxEpisodesPerProgram: 5,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

test("PODCAST-05 strict sequence may place two consecutive episodes when both fit", () => {
  const result = planRun({
    pools: {
      music: [],
      podcasts: [episode("73", 60_000), episode("74", 60_000), episode("75", 60_000)],
    },
    targets: [target(120_000)],
  });

  assert.deepEqual(
    result.targets[0]?.result.items.map((item) => item.spotifyEpisodeId),
    ["73", "74"],
  );
});

test("PODCAST-05 strict sequence never skips the next episode just because a later one fits", () => {
  const result = planRun({
    pools: {
      music: [],
      podcasts: [episode("73", 90_000), episode("74", 30_000)],
    },
    targets: [target(60_000)],
  });

  assert.deepEqual(result.targets[0]?.result.items, []);
});
