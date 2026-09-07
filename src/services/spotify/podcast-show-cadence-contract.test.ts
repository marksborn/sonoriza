import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PODCAST_SHOW_PRIORITY,
  normalizePodcastShowCadence,
  podcastCadenceConsumptionObservedAt,
} from "./podcast-show-cadence-contract";

test("cadence disabled is represented canonically as null/null", () => {
  assert.deepEqual(
    normalizePodcastShowCadence({
      cadenceMaxEpisodes: null,
      cadenceUnit: null,
    }),
    {
      cadenceMaxEpisodes: null,
      cadenceUnit: null,
    },
  );
  assert.equal(DEFAULT_PODCAST_SHOW_PRIORITY, "NORMAL");
});

test("cadence accepts a positive civil-calendar budget", () => {
  assert.deepEqual(
    normalizePodcastShowCadence({
      cadenceMaxEpisodes: 1,
      cadenceUnit: "WEEK",
    }),
    {
      cadenceMaxEpisodes: 1,
      cadenceUnit: "WEEK",
    },
  );
});

test("cadence rejects a half-configured policy", () => {
  assert.throws(
    () =>
      normalizePodcastShowCadence({
        cadenceMaxEpisodes: 1,
        cadenceUnit: null,
      }),
    /Podcast cadence must be disabled/,
  );
  assert.throws(
    () =>
      normalizePodcastShowCadence({
        cadenceMaxEpisodes: null,
        cadenceUnit: "MONTH",
      }),
    /Podcast cadence must be disabled/,
  );
});

test("cadence rejects zero and negative budgets", () => {
  for (const cadenceMaxEpisodes of [0, -1]) {
    assert.throws(
      () =>
        normalizePodcastShowCadence({
          cadenceMaxEpisodes,
          cadenceUnit: "DAY",
        }),
      /positive episode budget/,
    );
  }
});

test("cadence consumption is based only on factual first progress evidence", () => {
  const observedAt = new Date("2026-09-07T15:00:00.000Z");

  assert.equal(
    podcastCadenceConsumptionObservedAt({ firstProgressObservedAt: observedAt }),
    observedAt,
  );
  assert.equal(
    podcastCadenceConsumptionObservedAt({ firstProgressObservedAt: null }),
    null,
  );
});
