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
    compositionMode: "PROPORTION",
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


function music(uri: string, durationMs = 60_000): Candidate {
  return { uri, type: "MUSIC", title: uri, durationMs };
}

test("#31 PROPORTION ignores the stored sequence as a physical rule", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: {
      compositionMode: "PROPORTION",
      targetDurationMs: 20 * minute,
      podcastPercent: 50,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 10,
    },
    pools: {
      music: [music("spotify:track:a", 5 * minute), music("spotify:track:b", 5 * minute)],
      podcasts: [podcast("spotify:episode:a", "show-a", 10 * minute)],
    },
  });
  assert.equal(result.items.some((item) => item.type === "PODCAST"), true);
  assert.equal(result.stats.compositionMode, "PROPORTION");
  assert.equal(result.stats.compositionQualityPassed, true);
});

test("#31 SEQUENCE repeats a simple cycle without substituting slot types", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 38 * minute,
      podcastPercent: 60,
      sequencePattern: ["MUSIC", "MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 10,
    },
    pools: {
      music: [music("m1", 4 * minute), music("m2", 4 * minute)],
      podcasts: [podcast("p1", "s1", 30 * minute)],
    },
  });
  assert.deepEqual(result.items.map((item) => item.type), ["MUSIC", "MUSIC", "PODCAST"]);
  assert.equal(result.stats.completedCycles, 1);
  assert.equal(result.stats.sequenceQualityPassed, true);
  assert.equal(result.stats.actualPodcastPercent > 70, true);
  assert.equal(result.stats.compositionQualityPassed, true);
});

test("#31 SEQUENCE repeats a complex cycle exactly", () => {
  const pattern = ["MUSIC", "MUSIC", "PODCAST", "PODCAST", "MUSIC", "MUSIC", "PODCAST"] as const;
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 14 * 60_000,
      podcastPercent: 50,
      sequencePattern: [...pattern],
      maxEpisodesPerProgram: 20,
    },
    pools: {
      music: Array.from({ length: 8 }, (_, i) => music(`m${i}`, 60_000)),
      podcasts: Array.from({ length: 6 }, (_, i) => podcast(`p${i}`, `s${i}`, 60_000)),
    },
  });
  assert.deepEqual(result.items.map((item) => item.type), [...pattern, ...pattern]);
  assert.equal(result.stats.completedCycles, 2);
});

test("#31 SEQUENCE stops instead of replacing a missing MUSIC slot with PODCAST", () => {
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 180_000,
      podcastPercent: 50,
      sequencePattern: ["MUSIC", "MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 10,
    },
    pools: {
      music: [music("m1")],
      podcasts: [podcast("p1", "s1"), podcast("p2", "s2")],
    },
  });
  assert.deepEqual(result.items.map((item) => item.type), ["MUSIC"]);
  assert.equal(result.stats.sequenceUnfilledSlots, 1);
  assert.equal(result.stats.stoppedAtPatternIndex, 1);
  assert.equal(result.stats.sequenceStopReason, "NO_CANDIDATE_FOR_SLOT");
  assert.equal(result.stats.compositionQualityPassed, true);
});

test("#31 SEQUENCE ends early when the next same-type item cannot fit", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 6 * minute,
      podcastPercent: 100,
      sequencePattern: ["PODCAST"],
      maxEpisodesPerProgram: 10,
    },
    pools: { music: [], podcasts: [podcast("p-long", "s-long", 20 * minute)] },
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.stats.sequenceStopReason, "NO_FITTING_CANDIDATE");
  assert.equal(result.stats.compositionQualityPassed, true);
});

test("#31 SEQUENCE preserves #27 duration eligibility and #29 program cap", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 20 * minute,
      podcastPercent: 100,
      sequencePattern: ["PODCAST", "PODCAST"],
      maxEpisodesPerProgram: 1,
      maxPodcastDurationMs: 10 * minute,
    },
    pools: {
      music: [],
      podcasts: [
        podcast("too-long", "show-long", 15 * minute),
        podcast("a1", "show-a", 10 * minute),
        podcast("a2", "show-a", 10 * minute),
        podcast("b1", "show-b", 10 * minute),
      ],
    },
  });
  assert.deepEqual(result.items.map((item) => item.uri), ["a1", "b1"]);
  assert.equal(result.stats.podcastDurationExceededCount, 1);
  assert.equal(result.stats.completedCycles, 1);
});
