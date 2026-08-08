import assert from "node:assert/strict";
import test from "node:test";

import { planPlaylist } from "./planner";
import type { Candidate, PlaylistRules } from "./types";

function podcast(
  uri: string,
  programId: string | undefined,
  durationMs = 60_000,
): Candidate {
  return {
    uri,
    type: "PODCAST",
    title: uri,
    programId,
    durationMs,
  };
}

function rules(
  targetDurationMs: number,
  maxEpisodesPerProgram = 1,
  maxPodcastDurationMs?: number | null,
): PlaylistRules {
  return {
    targetDurationMs,
    podcastPercent: 100,
    sequencePattern: ["PODCAST"],
    maxEpisodesPerProgram,
    maxPodcastDurationMs,
  };
}

test("#29 regression: missing programId cannot bypass the per-program cap", () => {
  const result = planPlaylist({
    rules: rules(120_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:first", "show-a"),
        podcast("spotify:episode:bypass", undefined),
      ],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.uri, "spotify:episode:first");
  assert.equal(result.stats.podcastIdentityMissingCount, 1);
  assert.equal(result.stats.podcastShortfallMs, 60_000);
});

test("caps two episodes from the same show at one when maxEpisodesPerProgram is one", () => {
  const result = planPlaylist({
    rules: rules(120_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:a", "show-a"),
        podcast("spotify:episode:b", "show-a"),
      ],
    },
  });

  assert.deepEqual(result.items.map((item) => item.uri), ["spotify:episode:a"]);
});

test("allows episodes from different shows", () => {
  const result = planPlaylist({
    rules: rules(120_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:a", "show-a"),
        podcast("spotify:episode:b", "show-b"),
      ],
    },
  });

  assert.equal(result.items.length, 2);
});

test("keeps URI deduplication when the same episode arrives more than once", () => {
  const result = planPlaylist({
    rules: rules(120_000, 2),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:same", "show-a"),
        podcast("spotify:episode:same", "show-a"),
        podcast("spotify:episode:other", "show-b"),
      ],
    },
  });

  assert.deepEqual(result.items.map((item) => item.uri), [
    "spotify:episode:same",
    "spotify:episode:other",
  ]);
});

test("keeps a valid duplicate when another source copy is missing programId", () => {
  const result = planPlaylist({
    rules: rules(60_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:same", undefined),
        podcast("spotify:episode:same", "show-a"),
      ],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.uri, "spotify:episode:same");
  assert.equal(result.items[0]?.programId, "show-a");
  assert.equal(result.stats.podcastIdentityMissingCount, 1);
});

test("rejects blank program identities and normalizes surrounding whitespace", () => {
  const result = planPlaylist({
    rules: rules(60_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:blank", "   "),
        podcast("spotify:episode:valid", " show-b "),
      ],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.programId, "show-b");
  assert.equal(result.stats.podcastIdentityMissingCount, 1);
});

test("honors maxEpisodesPerProgram values greater than one", () => {
  const result = planPlaylist({
    rules: rules(180_000, 2),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:a", "show-a"),
        podcast("spotify:episode:b", "show-a"),
        podcast("spotify:episode:c", "show-a"),
      ],
    },
  });

  assert.equal(result.items.length, 2);
});

test("shares the same show cap across candidates coming from different sources", () => {
  const result = planPlaylist({
    rules: rules(120_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:saved", "show-a"),
        podcast("spotify:episode:show-source", "show-a"),
      ],
    },
  });

  assert.equal(result.items.length, 1);
});

test("#27 rejects podcast candidates whose effective duration exceeds the configured limit", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: rules(30 * minute, 1, 45 * minute),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:too-long", "show-a", 50 * minute),
        podcast("spotify:episode:fits", "show-b", 30 * minute),
      ],
    },
  });

  assert.deepEqual(result.items.map((item) => item.uri), ["spotify:episode:fits"]);
  assert.equal(result.stats.podcastDurationExceededCount, 1);
  assert.equal(result.stats.podcastShortfallMs, 0);
});

test("#27 compares the limit with remaining listening time, not catalog duration", () => {
  const minute = 60_000;
  const partiallyPlayed: Candidate = {
    ...podcast("spotify:episode:partial", "show-a", 30 * minute),
    originalDurationMs: 120 * minute,
    resumePositionMs: 90 * minute,
    playbackPositionKnown: true,
  };

  const result = planPlaylist({
    rules: rules(30 * minute, 1, 45 * minute),
    pools: { music: [], podcasts: [partiallyPlayed] },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.durationMs, 30 * minute);
  assert.equal(result.stats.podcastDurationExceededCount, 0);
});

test("#27 preserves current behavior when no podcast duration limit is configured", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: rules(60 * minute, 1, null),
    pools: {
      music: [],
      podcasts: [podcast("spotify:episode:long", "show-a", 60 * minute)],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.stats.podcastDurationExceededCount, 0);
});
