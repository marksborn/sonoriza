import assert from "node:assert/strict";
import test from "node:test";

import { mergePodcastListeningState } from "./podcast-listening-state";
import { evaluatePodcastShowCadenceShadow } from "./podcast-show-cadence-shadow";

const showId = "2ncLC8MhGwXeQFGOipZa5z";

function observeEpisode(input: {
  episodeId: string;
  resumePositionMs: number;
  observedAt: Date;
}) {
  return mergePodcastListeningState(null, {
    spotifyEpisodeId: input.episodeId,
    spotifyShowId: showId,
    spotifyUri: `spotify:episode:${input.episodeId}`,
    durationMs: 3_600_000,
    resumePositionMs: input.resumePositionMs,
    fullyPlayed: false,
    observedAt: input.observedAt,
  });
}

test("PODCAST-07 1/WEEK/PER_SHOW counts progress first observed inside the week", () => {
  const listened = observeEpisode({
    episodeId: "episode-listened-this-morning",
    resumePositionMs: 1_260_695,
    observedAt: new Date("2026-09-14T12:00:00.000Z"),
  });

  const cadence = evaluatePodcastShowCadenceShadow({
    evidence: [listened],
    showId,
    maxEpisodes: 1,
    unit: "WEEK",
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-14T22:37:25.973Z"),
  });

  assert.equal(cadence.consumedCount, 1);
  assert.equal(cadence.limitReached, true);
  assert.equal(cadence.newEpisodeAllowedByCadence, false);
  assert.deepEqual(cadence.consumedEpisodeIds, ["episode-listened-this-morning"]);
  assert.deepEqual(cadence.inProgressContinuationEpisodeIds, [
    "episode-listened-this-morning",
  ]);
});

test("PODCAST-07 does not spend weekly cadence for an unplayed episode", () => {
  const notStarted = observeEpisode({
    episodeId: "episode-not-started",
    resumePositionMs: 0,
    observedAt: new Date("2026-09-14T12:00:00.000Z"),
  });

  const cadence = evaluatePodcastShowCadenceShadow({
    evidence: [notStarted],
    showId,
    maxEpisodes: 1,
    unit: "WEEK",
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-14T22:37:25.973Z"),
  });

  assert.equal(cadence.consumedCount, 0);
  assert.equal(cadence.limitReached, false);
  assert.equal(cadence.newEpisodeAllowedByCadence, true);
});
