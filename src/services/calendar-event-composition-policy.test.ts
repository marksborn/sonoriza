import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultCalendarEventCompositionPolicy,
  normalizeCalendarEventCompositionPolicy,
} from "./calendar-event-composition-policy";

test("CALENDAR-03 defaults preserve existing destination composition", () => {
  assert.deepEqual(defaultCalendarEventCompositionPolicy("target-1"), {
    targetPlaylistId: "target-1",
    eventCompositionPolicy: "INHERIT_DESTINATION",
    maxPodcastsPerEvent: 1,
    podcastEventSafetyMarginSeconds: 0,
    podcastEventDistribution: "EVERY_EVENT",
    podcastEveryNEvents: 1,
    podcastEventOffset: 0,
  });
});

test("EVERY_EVENT has one canonical cycle representation", () => {
  assert.deepEqual(
    normalizeCalendarEventCompositionPolicy("target-1", {
      eventCompositionPolicy: "PODCAST_THEN_MUSIC",
      maxPodcastsPerEvent: 1,
      podcastEventSafetyMarginSeconds: 120,
      podcastEventDistribution: "EVERY_EVENT",
      podcastEveryNEvents: 99,
      podcastEventOffset: 42,
    }),
    {
      targetPlaylistId: "target-1",
      eventCompositionPolicy: "PODCAST_THEN_MUSIC",
      maxPodcastsPerEvent: 1,
      podcastEventSafetyMarginSeconds: 120,
      podcastEventDistribution: "EVERY_EVENT",
      podcastEveryNEvents: 1,
      podcastEventOffset: 0,
    },
  );
});

test("EVERY_N_EVENTS accepts deterministic N + offset", () => {
  assert.deepEqual(
    normalizeCalendarEventCompositionPolicy("target-1", {
      eventCompositionPolicy: "PODCAST_THEN_MUSIC",
      maxPodcastsPerEvent: 2,
      podcastEventSafetyMarginSeconds: 0,
      podcastEventDistribution: "EVERY_N_EVENTS",
      podcastEveryNEvents: 2,
      podcastEventOffset: 1,
    }),
    {
      targetPlaylistId: "target-1",
      eventCompositionPolicy: "PODCAST_THEN_MUSIC",
      maxPodcastsPerEvent: 2,
      podcastEventSafetyMarginSeconds: 0,
      podcastEventDistribution: "EVERY_N_EVENTS",
      podcastEveryNEvents: 2,
      podcastEventOffset: 1,
    },
  );
});

test("contract rejects non-positive podcast caps and negative safety margins", () => {
  assert.throws(
    () =>
      normalizeCalendarEventCompositionPolicy("target-1", {
        eventCompositionPolicy: "PODCAST_THEN_MUSIC",
        maxPodcastsPerEvent: 0,
        podcastEventSafetyMarginSeconds: 0,
        podcastEventDistribution: "EVERY_EVENT",
      }),
    /maxPodcastsPerEvent must be a positive integer/,
  );

  assert.throws(
    () =>
      normalizeCalendarEventCompositionPolicy("target-1", {
        eventCompositionPolicy: "PODCAST_THEN_MUSIC",
        maxPodcastsPerEvent: 1,
        podcastEventSafetyMarginSeconds: -1,
        podcastEventDistribution: "EVERY_EVENT",
      }),
    /podcastEventSafetyMarginSeconds must be a non-negative integer/,
  );
});

test("EVERY_N_EVENTS rejects incomplete or out-of-range cycles", () => {
  for (const input of [
    { podcastEveryNEvents: 0, podcastEventOffset: 0 },
    { podcastEveryNEvents: 2, podcastEventOffset: -1 },
    { podcastEveryNEvents: 2, podcastEventOffset: 2 },
    { podcastEveryNEvents: 2, podcastEventOffset: 3 },
  ]) {
    assert.throws(() =>
      normalizeCalendarEventCompositionPolicy("target-1", {
        eventCompositionPolicy: "PODCAST_THEN_MUSIC",
        maxPodcastsPerEvent: 1,
        podcastEventSafetyMarginSeconds: 0,
        podcastEventDistribution: "EVERY_N_EVENTS",
        ...input,
      }),
    );
  }
});

test("target id is required", () => {
  assert.throws(
    () => defaultCalendarEventCompositionPolicy("   "),
    /targetPlaylistId is required/,
  );
});
