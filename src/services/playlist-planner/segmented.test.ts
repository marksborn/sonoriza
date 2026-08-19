import assert from "node:assert/strict";
import test from "node:test";

import { applyMusicOrder } from "@/services/playlist-ordering";

import { planRun } from "./plan-run";
import type { Candidate, PlaylistRules, RunTarget } from "./index";

const MINUTE = 60_000;

function music(
  id: string,
  minutes: number,
  artistId = `artist:${id}`,
  albumId = `album:${id}`,
): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: artistId,
    albumId,
    durationMs: minutes * MINUTE,
  };
}

function podcast(id: string, minutes: number, originalMinutes = minutes): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    programId: `show:${id}`,
    durationMs: minutes * MINUTE,
    originalDurationMs: originalMinutes * MINUTE,
    resumePositionMs: (originalMinutes - minutes) * MINUTE,
    playbackPositionKnown: true,
  };
}

function rules(overrides: Partial<PlaylistRules> = {}): PlaylistRules {
  return {
    targetDurationMs: 71 * MINUTE,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: ["MUSIC", "PODCAST"],
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
    ...overrides,
  };
}

function target(
  overrides: Partial<RunTarget> = {},
): RunTarget {
  return {
    targetPlaylistId: "target",
    name: "Target",
    priority: 0,
    rules: rules(),
    ...overrides,
  };
}

test("CALENDAR-02 keeps SUMMED behavior but PER_EVENT never borrows the next block", () => {
  const pools = {
    music: [music("long-50", 50), music("thirty-a", 30), music("thirty-b", 30), music("five", 5)],
    podcasts: [],
  };

  const summed = planRun({ pools, targets: [target()] }).targets[0]!.result;
  assert.equal(summed.stats.segmentation, undefined);
  assert.equal(summed.items[0]?.uri, "spotify:track:long-50");
  assert.ok(summed.stats.totalDurationMs >= 71 * MINUTE);

  const segmented = planRun({
    pools,
    targets: [
      target({
        durationBlocks: [
          { key: "event-a", targetDurationMs: 35 * MINUTE },
          { key: "event-b", targetDurationMs: 36 * MINUTE },
        ],
      }),
    ],
  }).targets[0]!.result;

  assert.deepEqual(
    segmented.items.map((item) => item.uri),
    ["spotify:track:thirty-a", "spotify:track:five", "spotify:track:thirty-b"],
  );
  assert.ok(!segmented.items.some((item) => item.uri === "spotify:track:long-50"));
  assert.deepEqual(
    segmented.stats.segmentation?.blocks.map((block) => ({
      target: block.targetDurationMs,
      filled: block.filledDurationMs,
      deficit: block.deficitMs,
    })),
    [
      { target: 35 * MINUTE, filled: 35 * MINUTE, deficit: 0 },
      { target: 36 * MINUTE, filled: 30 * MINUTE, deficit: 6 * MINUTE },
    ],
  );
  assert.equal(segmented.stats.segmentation?.deficitMs, 6 * MINUTE);
  assert.equal(segmented.stats.compositionQualityPassed, true);
});

test("CALENDAR-02 uses remaining podcast duration when it fits an event block", () => {
  const remaining = podcast("resume", 20, 50);
  const result = planRun({
    pools: { music: [], podcasts: [remaining] },
    targets: [
      target({
        rules: rules({ podcastPercent: 100 }),
        durationBlocks: [{ key: "35-min-event", targetDurationMs: 35 * MINUTE }],
      }),
    ],
  }).targets[0]!.result;

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.durationMs, 20 * MINUTE);
  assert.equal(result.items[0]?.originalDurationMs, 50 * MINUTE);
  assert.equal(result.stats.segmentation?.blocks[0]?.deficitMs, 15 * MINUTE);
});

test("CALENDAR-02 keeps SEQUENCE continuous while resetting each event duration budget", () => {
  const result = planRun({
    pools: {
      music: [music("m1", 5), music("m2", 5)],
      podcasts: [podcast("p1", 5)],
    },
    targets: [
      target({
        rules: rules({
          compositionMode: "SEQUENCE",
          sequencePattern: ["MUSIC", "PODCAST"],
          targetDurationMs: 15 * MINUTE,
        }),
        durationBlocks: [
          { key: "first", targetDurationMs: 10 * MINUTE },
          { key: "second", targetDurationMs: 5 * MINUTE },
        ],
      }),
    ],
  }).targets[0]!.result;

  assert.deepEqual(
    result.items.map((item) => item.type),
    ["MUSIC", "PODCAST", "MUSIC"],
  );
  assert.deepEqual(
    result.items.map((item) => item.planningBlockIndex),
    [0, 0, 1],
  );
  assert.equal(result.stats.sequenceQualityPassed, true);
});

test("CALENDAR-02 threads music diversity constraints across event blocks", () => {
  const result = planRun({
    pools: {
      music: [
        music("a1", 5, "artist-a", "album-a1"),
        music("a2", 5, "artist-a", "album-a2"),
        music("b1", 5, "artist-b", "album-b1"),
      ],
      podcasts: [],
    },
    targets: [
      target({
        rules: rules({ maxTracksPerArtist: 1, targetDurationMs: 10 * MINUTE }),
        durationBlocks: [
          { key: "first", targetDurationMs: 5 * MINUTE },
          { key: "second", targetDurationMs: 5 * MINUTE },
        ],
      }),
    ],
  }).targets[0]!.result;

  assert.deepEqual(
    result.items.map((item) => item.spotifyTrackId),
    ["a1", "b1"],
  );
  assert.equal(result.stats.distinctArtistCount, 2);
});

test("ORDER-01 randomizes music only inside each CALENDAR-02 block", () => {
  const input = [
    { ...music("a", 3), position: 0, planningBlockIndex: 0 },
    { ...music("b", 8), position: 1, planningBlockIndex: 0 },
    { ...music("c", 20), position: 2, planningBlockIndex: 1 },
    { ...music("d", 25), position: 3, planningBlockIndex: 1 },
  ];

  const ordered = applyMusicOrder(input, "RANDOMIZED", "calendar-02-seed").items;

  assert.deepEqual(
    new Set(ordered.filter((item) => item.planningBlockIndex === 0).map((item) => item.uri)),
    new Set(["spotify:track:a", "spotify:track:b"]),
  );
  assert.deepEqual(
    new Set(ordered.filter((item) => item.planningBlockIndex === 1).map((item) => item.uri)),
    new Set(["spotify:track:c", "spotify:track:d"]),
  );
  assert.deepEqual(
    ordered.map((item) => item.planningBlockIndex),
    [0, 0, 1, 1],
  );
});
