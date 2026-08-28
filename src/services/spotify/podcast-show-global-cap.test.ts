import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type Candidate, type RunTarget } from "@/services/playlist-planner";

function podcast(
  show: string,
  episode: string,
  cap: number | null,
): Candidate {
  return {
    uri: `spotify:episode:${episode}`,
    spotifyEpisodeId: episode,
    type: "PODCAST",
    title: episode,
    programId: show,
    durationMs: 60_000,
    podcastMaxEpisodesPerCycle: cap,
    podcastStrictSequence: false,
  };
}

function strictPodcast(
  show: string,
  episode: string,
  cap: number | null,
  durationMs = 60_000,
): Candidate {
  return {
    ...podcast(show, episode, cap),
    durationMs,
    podcastStrictSequence: true,
  };
}

function target(
  id: string,
  priority: number,
  maxPerProgram = 5,
  targetDurationMs = 60_000,
): RunTarget {
  return {
    targetPlaylistId: id,
    name: id,
    priority,
    rules: {
      targetDurationMs,
      compositionMode: "PROPORTION",
      podcastPercent: 100,
      sequencePattern: ["PODCAST"],
      maxEpisodesPerProgram: maxPerProgram,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

function showItems(result: ReturnType<typeof planRun>, show: string) {
  return result.targets.flatMap((entry) =>
    entry.result.items.filter(
      (item) => item.type === "PODCAST" && item.programId === show,
    ),
  );
}

test("per-show cap 1 is shared by every destination in the generation run", () => {
  const result = planRun({
    pools: {
      music: [],
      podcasts: [
        podcast("show-a", "a1", 1),
        podcast("show-a", "a2", 1),
        podcast("show-a", "a3", 1),
      ],
    },
    targets: [target("car", 0), target("work", 1), target("home", 2)],
  });

  assert.equal(showItems(result, "show-a").length, 1);
});

test("per-show cap 2 can be distributed across two destinations but never exceeded", () => {
  const result = planRun({
    pools: {
      music: [],
      podcasts: [
        podcast("show-a", "a1", 2),
        podcast("show-a", "a2", 2),
        podcast("show-a", "a3", 2),
      ],
    },
    targets: [target("car", 0), target("work", 1), target("home", 2)],
  });

  assert.equal(showItems(result, "show-a").length, 2);
  assert.equal(new Set(showItems(result, "show-a").map((item) => item.uri)).size, 2);
});

test("strict sequence can place consecutive episodes in one destination when both fit", () => {
  const result = planRun({
    pools: {
      music: [],
      podcasts: [
        strictPodcast("show-a", "73", 2),
        strictPodcast("show-a", "74", 2),
        strictPodcast("show-a", "75", 2),
      ],
    },
    targets: [target("car", 0, 5, 120_000)],
  });

  assert.deepEqual(
    showItems(result, "show-a").map((item) => item.spotifyEpisodeId),
    ["73", "74"],
  );
});

test("strict sequence never lets a later episode jump ahead when the next one cannot fit", () => {
  const result = planRun({
    pools: {
      music: [],
      podcasts: [
        strictPodcast("show-a", "73", 2, 90_000),
        strictPodcast("show-a", "74", 2, 30_000),
      ],
    },
    targets: [target("car", 0, 5, 60_000)],
  });

  assert.deepEqual(showItems(result, "show-a"), []);
});

test("different shows keep independent global budgets", () => {
  const result = planRun({
    pools: {
      music: [],
      podcasts: [
        podcast("show-a", "a1", 1),
        podcast("show-b", "b1", 1),
        podcast("show-a", "a2", 1),
        podcast("show-b", "b2", 1),
      ],
    },
    targets: [target("car", 0), target("work", 1)],
  });

  assert.equal(showItems(result, "show-a").length, 1);
  assert.equal(showItems(result, "show-b").length, 1);
});

test("legacy target maxEpisodesPerProgram is also no longer reset per destination", () => {
  const result = planRun({
    pools: {
      music: [],
      podcasts: [
        podcast("show-a", "a1", null),
        podcast("show-a", "a2", null),
      ],
    },
    targets: [target("car", 0, 1), target("work", 1, 1)],
  });

  assert.equal(showItems(result, "show-a").length, 1);
});
