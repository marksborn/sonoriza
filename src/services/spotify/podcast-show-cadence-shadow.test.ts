import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePodcastShowCadenceShadow,
  resolvePodcastCadenceWindow,
  type PodcastCadenceEvidence,
} from "./podcast-show-cadence-shadow";

const TIME_ZONE = "America/Sao_Paulo";
const AS_OF = new Date("2026-09-07T21:00:00.000Z");
const SHOW_ID = "0qfFcilKpNKkXy8TbZ4moP";

test("WEEK uses civil Monday-to-Monday boundaries in the user time zone", () => {
  const window = resolvePodcastCadenceWindow({
    asOf: AS_OF,
    timeZone: TIME_ZONE,
    unit: "WEEK",
  });

  assert.equal(window.localStartDate, "2026-09-07");
  assert.equal(window.localEndDateExclusive, "2026-09-14");
  assert.equal(window.start.toISOString(), "2026-09-07T03:00:00.000Z");
  assert.equal(window.endExclusive.toISOString(), "2026-09-14T03:00:00.000Z");
});

test("DAY and MONTH use local civil boundaries instead of rolling durations", () => {
  const day = resolvePodcastCadenceWindow({
    asOf: AS_OF,
    timeZone: TIME_ZONE,
    unit: "DAY",
  });
  assert.equal(day.start.toISOString(), "2026-09-07T03:00:00.000Z");
  assert.equal(day.endExclusive.toISOString(), "2026-09-08T03:00:00.000Z");

  const month = resolvePodcastCadenceWindow({
    asOf: AS_OF,
    timeZone: TIME_ZONE,
    unit: "MONTH",
  });
  assert.equal(month.localStartDate, "2026-09-01");
  assert.equal(month.localEndDateExclusive, "2026-10-01");
  assert.equal(month.start.toISOString(), "2026-09-01T03:00:00.000Z");
  assert.equal(month.endExclusive.toISOString(), "2026-10-01T03:00:00.000Z");
});

test("1/WEEK is consumed by factual first progress and still preserves IN_PROGRESS continuation", () => {
  const evidence: PodcastCadenceEvidence[] = [
    {
      spotifyEpisodeId: "3oudiFs2CLZNfohYOuegV1",
      spotifyShowId: SHOW_ID,
      status: "IN_PROGRESS",
      firstProgressObservedAt: new Date("2026-09-07T08:20:02.363Z"),
    },
    {
      spotifyEpisodeId: "future-new-episode",
      spotifyShowId: SHOW_ID,
      status: "NOT_STARTED",
      firstProgressObservedAt: null,
    },
  ];

  const evaluation = evaluatePodcastShowCadenceShadow({
    evidence,
    showId: SHOW_ID,
    maxEpisodes: 1,
    unit: "WEEK",
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(evaluation.consumedCount, 1);
  assert.deepEqual(evaluation.consumedEpisodeIds, ["3oudiFs2CLZNfohYOuegV1"]);
  assert.equal(evaluation.limitReached, true);
  assert.equal(evaluation.newEpisodeAllowedByCadence, false);
  assert.deepEqual(evaluation.inProgressContinuationEpisodeIds, [
    "3oudiFs2CLZNfohYOuegV1",
  ]);
});

test("the same episode cannot consume cadence twice through duplicate observations", () => {
  const duplicate: PodcastCadenceEvidence = {
    spotifyEpisodeId: "episode-1",
    spotifyShowId: SHOW_ID,
    status: "COMPLETED",
    firstProgressObservedAt: new Date("2026-09-07T10:00:00.000Z"),
  };

  const evaluation = evaluatePodcastShowCadenceShadow({
    evidence: [duplicate, duplicate],
    showId: SHOW_ID,
    maxEpisodes: 2,
    unit: "WEEK",
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(evaluation.consumedCount, 1);
  assert.equal(evaluation.limitReached, false);
});

test("legacy completed evidence without firstProgressObservedAt is reported but not invented as consumption", () => {
  const evaluation = evaluatePodcastShowCadenceShadow({
    evidence: [
      {
        spotifyEpisodeId: "legacy-completed",
        spotifyShowId: SHOW_ID,
        status: "COMPLETED",
        firstProgressObservedAt: null,
      },
    ],
    showId: SHOW_ID,
    maxEpisodes: 1,
    unit: "WEEK",
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(evaluation.consumedCount, 0);
  assert.equal(evaluation.limitReached, false);
  assert.deepEqual(evaluation.legacyConsumptionWithoutTimestampEpisodeIds, [
    "legacy-completed",
  ]);
});

test("progress outside the current civil window does not consume the new window", () => {
  const evaluation = evaluatePodcastShowCadenceShadow({
    evidence: [
      {
        spotifyEpisodeId: "previous-week",
        spotifyShowId: SHOW_ID,
        status: "COMPLETED",
        firstProgressObservedAt: new Date("2026-09-06T20:00:00.000Z"),
      },
    ],
    showId: SHOW_ID,
    maxEpisodes: 1,
    unit: "WEEK",
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(evaluation.consumedCount, 0);
  assert.equal(evaluation.newEpisodeAllowedByCadence, true);
});
