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
): PlaylistRules {
  return {
    targetDurationMs,
    podcastPercent: 100,
    sequencePattern: ["PODCAST"],
    maxEpisodesPerProgram,
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
