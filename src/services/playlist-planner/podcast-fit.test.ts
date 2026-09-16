import assert from "node:assert/strict";
import test from "node:test";

import { selectFittingPodcastsInCanonicalOrder } from "./podcast-fit";
import type { Candidate, PlaylistRules } from "./types";

const MINUTE = 60_000;

function podcast(
  id: string,
  effectiveMinutes: number,
  options: Partial<Candidate> = {},
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId: `show:${id}`,
    durationMs: effectiveMinutes * MINUTE,
    podcastListeningStatus: "NOT_STARTED",
    ...options,
  };
}

function rules(overrides: Partial<PlaylistRules> = {}): PlaylistRules {
  return {
    targetDurationMs: 30 * MINUTE,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: [],
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
    ...overrides,
  };
}

test("Gate 5 keeps canonical order: duration filters but never best-fit ranks", () => {
  const result = selectFittingPodcastsInCanonicalOrder({
    candidates: [
      podcast("priority-18", 18),
      podcast("later-best-fit-29", 29),
    ],
    budgetMs: 30 * MINUTE,
    maxCount: 1,
    rules: rules(),
  });

  assert.deepEqual(result.selected.map((item) => item.uri), [
    "spotify:episode:priority-18",
  ]);
  assert.equal(result.selectedDurationMs, 18 * MINUTE);
});

test("Gate 5 IN_PROGRESS uses effective remaining duration instead of original duration", () => {
  const resumed = podcast("resume", 12, {
    originalDurationMs: 40 * MINUTE,
    resumePositionMs: 28 * MINUTE,
    playbackPositionKnown: true,
    podcastListeningStatus: "IN_PROGRESS",
  });

  const result = selectFittingPodcastsInCanonicalOrder({
    candidates: [resumed],
    budgetMs: 15 * MINUTE,
    maxCount: 1,
    rules: rules(),
  });

  assert.deepEqual(result.selected.map((item) => item.uri), [
    "spotify:episode:resume",
  ]);
  assert.equal(result.selectedDurationMs, 12 * MINUTE);
  assert.equal(result.selected[0]?.originalDurationMs, 40 * MINUTE);
});

test("Gate 5 strict sequence never jumps an unfitting head episode from the same show", () => {
  const result = selectFittingPodcastsInCanonicalOrder({
    candidates: [
      podcast("head-too-long", 35, {
        programId: "strict-show",
        podcastStrictSequence: true,
      }),
      podcast("later-would-fit", 10, {
        programId: "strict-show",
        podcastStrictSequence: true,
      }),
    ],
    budgetMs: 30 * MINUTE,
    maxCount: 1,
    rules: rules({ maxEpisodesPerProgram: 2 }),
  });

  assert.deepEqual(result.selected, []);
  assert.equal(result.selectedDurationMs, 0);
});

test("Gate 5 intersects destination max duration and show/cycle cap", () => {
  const result = selectFittingPodcastsInCanonicalOrder({
    candidates: [
      podcast("too-long-for-destination", 25, { programId: "show-a" }),
      podcast("show-at-cap", 10, {
        programId: "show-b",
        podcastMaxEpisodesPerCycle: 1,
      }),
      podcast("eligible", 8, { programId: "show-c" }),
    ],
    budgetMs: 30 * MINUTE,
    maxCount: 1,
    programCounts: new Map([["show-b", 1]]),
    rules: rules({ maxEpisodesPerProgram: 2, maxPodcastDurationMs: 20 * MINUTE }),
  });

  assert.deepEqual(result.selected.map((item) => item.uri), [
    "spotify:episode:eligible",
  ]);
  assert.equal(result.selectedDurationMs, 8 * MINUTE);
});
