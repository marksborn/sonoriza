import assert from "node:assert/strict";
import test from "node:test";

import { refreshAuthoritativePodcastListeningStates } from "./podcast-authoritative-state";
import { createVolatilePodcastListeningStateStore } from "./podcast-listening-state";
import { evaluatePodcastShowCadenceShadow } from "./podcast-show-cadence-shadow";
import {
  PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES,
  recentPublishedEpisodeIds,
  selectPodcast07PlaybackRefreshEpisodeIds,
} from "./podcast07-playback-refresh";

const NOW = new Date("2026-09-14T22:15:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(
  spotifyEpisodeId: string,
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED",
  ageMs: number,
) {
  return {
    spotifyEpisodeId,
    status,
    lastObservedAt: new Date(NOW.getTime() - ageMs),
  };
}

test("refresh scope keeps only the two most recently published episodes per show", () => {
  const ids = recentPublishedEpisodeIds(
    new Map([
      ["show-a", ["a-1", "a-2", "a-3", "a-3"]],
      ["show-b", ["b-1", "b-2", "b-3"]],
    ]),
  );

  assert.deepEqual([...ids].sort(), ["a-2", "a-3", "b-2", "b-3"]);
});

test("refresh selection enforces TTL, recent window, sticky completion and hard provider cap", () => {
  const byShow = new Map<string, readonly string[]>();
  const states = [];

  for (let index = 0; index < 12; index += 1) {
    const id = `episode-${index}`;
    byShow.set(`show-${index}`, [id]);
    states.push(row(id, "NOT_STARTED", (index + 2) * HOUR));
  }

  byShow.set("show-completed", ["completed"]);
  states.push(row("completed", "COMPLETED", 3 * HOUR));

  byShow.set("show-fresh", ["fresh"]);
  states.push(row("fresh", "IN_PROGRESS", 30 * 60 * 1000));

  byShow.set("show-old", ["old"]);
  states.push(row("old", "NOT_STARTED", 15 * DAY));

  const selected = selectPodcast07PlaybackRefreshEpisodeIds({
    publishedEpisodeIdsByShow: byShow,
    listeningStates: states,
    now: NOW,
  });

  assert.equal(selected.length, PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES);
  assert.deepEqual(selected, [
    "episode-0",
    "episode-1",
    "episode-2",
    "episode-3",
    "episode-4",
    "episode-5",
    "episode-6",
    "episode-7",
  ]);
  assert.equal(selected.includes("completed"), false);
  assert.equal(selected.includes("fresh"), false);
  assert.equal(selected.includes("old"), false);
});

test("#350 Japan regression: stale NOT_STARTED refreshes to COMPLETED before weekly cadence", async () => {
  const userId = "cmshwqbpw0000jipbjo70j5nq";
  const showId = "2ncLC8MhGwXeQFGOipZa5z";
  const japanEpisodeId = "65fR8aTTAiOFQVSs9YkCpb";
  const store = createVolatilePodcastListeningStateStore();

  await store.observe(userId, [
    {
      spotifyEpisodeId: japanEpisodeId,
      spotifyShowId: showId,
      spotifyUri: `spotify:episode:${japanEpisodeId}`,
      durationMs: 2_000,
      resumePositionMs: 0,
      fullyPlayed: false,
      observedAt: new Date("2026-09-14T09:15:20.013Z"),
    },
  ]);

  const selected = selectPodcast07PlaybackRefreshEpisodeIds({
    publishedEpisodeIdsByShow: new Map([[showId, [japanEpisodeId]]]),
    listeningStates: [
      {
        spotifyEpisodeId: japanEpisodeId,
        status: "NOT_STARTED",
        lastObservedAt: new Date("2026-09-14T09:15:20.013Z"),
      },
    ],
    now: NOW,
  });
  assert.deepEqual(selected, [japanEpisodeId]);

  let providerCalls = 0;
  const refreshed = await refreshAuthoritativePodcastListeningStates(
    userId,
    selected,
    NOW,
    {
      stateStore: store,
      episodeReader: async (episodeId) => {
        providerCalls += 1;
        assert.equal(episodeId, japanEpisodeId);
        return {
          id: japanEpisodeId,
          uri: `spotify:episode:${japanEpisodeId}`,
          type: "episode",
          duration_ms: 2_000,
          show: { id: showId, name: "Os três elementos" },
          resume_point: { fully_played: true, resume_position_ms: 0 },
        };
      },
    },
  );

  const japan = refreshed.get(japanEpisodeId);
  assert.equal(providerCalls, 1);
  assert.equal(japan?.status, "COMPLETED");
  assert.equal(japan?.fullyPlayed, true);
  assert.equal(japan?.firstProgressObservedAt?.toISOString(), NOW.toISOString());

  const cadence = evaluatePodcastShowCadenceShadow({
    evidence: [
      {
        spotifyEpisodeId: japanEpisodeId,
        spotifyShowId: showId,
        status: japan!.status,
        firstProgressObservedAt: japan!.firstProgressObservedAt,
      },
    ],
    showId,
    maxEpisodes: 1,
    unit: "WEEK",
    timeZone: "America/Sao_Paulo",
    asOf: NOW,
  });

  assert.equal(cadence.consumedCount, 1);
  assert.equal(cadence.limitReached, true);
  assert.equal(cadence.newEpisodeAllowedByCadence, false);
  assert.deepEqual(cadence.completedConsumedEpisodeIds, [japanEpisodeId]);
});
