import assert from "node:assert/strict";
import test from "node:test";

import { refreshAuthoritativePodcastListeningStates } from "./podcast-authoritative-state";
import { createVolatilePodcastListeningStateStore } from "./podcast-listening-state";
import { evaluatePodcastShowCadenceShadow } from "./podcast-show-cadence-shadow";
import {
  PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES,
  planPodcast07PlaybackRefresh,
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

test("refresh rotates the oldest unresolved episode per show instead of only recent publications", () => {
  const byShow = new Map<string, readonly string[]>([
    ["show-a", ["a-old", "a-new-1", "a-new-2"]],
    ["show-b", ["b-old", "b-new"]],
  ]);
  const plan = planPodcast07PlaybackRefresh({
    publishedEpisodeIdsByShow: byShow,
    listeningStates: [
      row("a-old", "NOT_STARTED", 20 * DAY),
      row("a-new-1", "NOT_STARTED", 3 * HOUR),
      row("a-new-2", "NOT_STARTED", 2 * HOUR),
      row("b-old", "IN_PROGRESS", 10 * DAY),
      row("b-new", "NOT_STARTED", 4 * HOUR),
    ],
    now: NOW,
  });

  assert.deepEqual(plan.selectedEpisodeIds, [
    "a-old",
    "b-old",
    "b-new",
    "a-new-1",
    "a-new-2",
  ]);
  assert.equal(plan.eligibleShowCount, 2);
  assert.equal(plan.selectedShowCount, 2);
  assert.equal(plan.skippedByBudgetCount, 0);
});

test("refresh selection keeps TTL, sticky completion and hard provider cap", () => {
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

  const plan = planPodcast07PlaybackRefresh({
    publishedEpisodeIdsByShow: byShow,
    listeningStates: states,
    now: NOW,
  });

  assert.equal(
    plan.selectedEpisodeIds.length,
    PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES,
  );
  assert.deepEqual(plan.selectedEpisodeIds, [
    "episode-11",
    "episode-10",
    "episode-9",
    "episode-8",
    "episode-7",
    "episode-6",
    "episode-5",
    "episode-4",
  ]);
  assert.equal(plan.eligibleEpisodeCount, 12);
  assert.equal(plan.eligibleShowCount, 12);
  assert.equal(plan.selectedShowCount, 8);
  assert.equal(plan.skippedByBudgetCount, 4);
  assert.equal(plan.selectedEpisodeIds.includes("completed"), false);
  assert.equal(plan.selectedEpisodeIds.includes("fresh"), false);
});

test("a refreshed row rotates out under TTL on the immediately repeated generation", () => {
  const byShow = new Map<string, readonly string[]>([["show-a", ["a-1", "a-2"]]]);
  const first = selectPodcast07PlaybackRefreshEpisodeIds({
    publishedEpisodeIdsByShow: byShow,
    listeningStates: [
      row("a-1", "NOT_STARTED", 5 * HOUR),
      row("a-2", "NOT_STARTED", 4 * HOUR),
    ],
    now: NOW,
  });
  assert.deepEqual(first, ["a-1", "a-2"]);

  const second = selectPodcast07PlaybackRefreshEpisodeIds({
    publishedEpisodeIdsByShow: byShow,
    listeningStates: [
      { ...row("a-1", "NOT_STARTED", 5 * HOUR), lastObservedAt: NOW },
      row("a-2", "NOT_STARTED", 4 * HOUR),
    ],
    now: NOW,
  });
  assert.deepEqual(second, ["a-2"]);
});

test("#350 Japan regression: older published episode is selected and completes before weekly cadence", async () => {
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
    publishedEpisodeIdsByShow: new Map([
      [showId, [japanEpisodeId, "newer-1", "newer-2"]],
    ]),
    listeningStates: [
      {
        spotifyEpisodeId: japanEpisodeId,
        status: "NOT_STARTED",
        lastObservedAt: new Date("2026-09-14T09:15:20.013Z"),
      },
      row("newer-1", "NOT_STARTED", 3 * HOUR),
      row("newer-2", "NOT_STARTED", 2 * HOUR),
    ],
    now: NOW,
  });
  assert.equal(selected[0], japanEpisodeId);

  let providerCalls = 0;
  const refreshed = await refreshAuthoritativePodcastListeningStates(
    userId,
    [japanEpisodeId],
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
