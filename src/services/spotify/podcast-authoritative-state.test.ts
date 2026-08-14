import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner";

import { createVolatilePodcastListeningStateStore } from "./podcast-listening-state";
import {
  checkPodcastCompletionBeforeWrite,
  refreshAuthoritativePodcastListeningStates,
} from "./podcast-authoritative-state";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function podcastCandidate(
  id: string,
  sourceIncludePlayed: boolean | undefined = false,
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    durationMs: 1_000,
    originalDurationMs: 1_000,
    resumePositionMs: 0,
    sourceSpotifyType: "SAVED_EPISODES",
    sourceSpotifyId: "me",
    sourceIncludePlayed,
  };
}

test("direct episode playback marks a previously not-started episode completed", async () => {
  const store = createVolatilePodcastListeningStateStore();
  await store.observe("user-1", [
    {
      spotifyEpisodeId: "episode-1",
      spotifyUri: "spotify:episode:episode-1",
      durationMs: 1_000,
      resumePositionMs: 0,
      fullyPlayed: false,
      observedAt: new Date("2026-08-14T08:00:00Z"),
    },
  ]);

  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return jsonResponse({
      id: "episode-1",
      uri: "spotify:episode:episode-1",
      type: "episode",
      duration_ms: 1_000,
      resume_point: {
        fully_played: true,
        resume_position_ms: 0,
      },
    });
  };

  const states = await refreshAuthoritativePodcastListeningStates(
    "user-1",
    ["episode-1"],
    new Date("2026-08-14T08:05:00Z"),
    {
      accessToken: "token",
      fetchImpl,
      stateStore: store,
    },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\/episodes\/episode-1\?market=from_token$/);
  assert.equal(states.get("episode-1")?.status, "COMPLETED");
  assert.equal(states.get("episode-1")?.fullyPlayed, true);
});

test("completion remains sticky when a later direct response says false/zero", async () => {
  const store = createVolatilePodcastListeningStateStore();
  await store.observe("user-1", [
    {
      spotifyEpisodeId: "episode-1",
      spotifyUri: "spotify:episode:episode-1",
      durationMs: 1_000,
      resumePositionMs: 900,
      fullyPlayed: true,
      observedAt: new Date("2026-08-14T08:00:00Z"),
    },
  ]);

  const states = await refreshAuthoritativePodcastListeningStates(
    "user-1",
    ["episode-1", "episode-1"],
    new Date("2026-08-14T08:05:00Z"),
    {
      accessToken: "token",
      fetchImpl: async () =>
        jsonResponse({
          id: "episode-1",
          uri: "spotify:episode:episode-1",
          type: "episode",
          duration_ms: 1_000,
          resume_point: {
            fully_played: false,
            resume_position_ms: 0,
          },
        }),
      stateStore: store,
    },
  );

  assert.equal(states.size, 1);
  assert.equal(states.get("episode-1")?.status, "COMPLETED");
  assert.equal(states.get("episode-1")?.fullyPlayed, true);
  assert.equal(states.get("episode-1")?.resumePositionMs, 900);
});

test("missing resume_point is inconclusive rather than proof of not-started", async () => {
  const store = createVolatilePodcastListeningStateStore();
  await store.observe("user-1", [
    {
      spotifyEpisodeId: "episode-1",
      spotifyUri: "spotify:episode:episode-1",
      durationMs: 1_000,
      resumePositionMs: 400,
      fullyPlayed: false,
      observedAt: new Date("2026-08-14T08:00:00Z"),
    },
  ]);

  const states = await refreshAuthoritativePodcastListeningStates(
    "user-1",
    ["episode-1"],
    new Date("2026-08-14T08:05:00Z"),
    {
      accessToken: "token",
      fetchImpl: async () =>
        jsonResponse({
          id: "episode-1",
          uri: "spotify:episode:episode-1",
          type: "episode",
          duration_ms: 1_000,
          resume_point: null,
        }),
      stateStore: store,
    },
  );

  assert.equal(states.get("episode-1")?.status, "IN_PROGRESS");
  assert.equal(states.get("episode-1")?.resumePositionMs, 400);
});

test("prewrite gate blocks a podcast that became completed after planning", async () => {
  const store = createVolatilePodcastListeningStateStore();
  let calls = 0;

  const result = await checkPodcastCompletionBeforeWrite(
    "user-1",
    [
      {
        targetPlaylistId: "target-1",
        targetName: "Carro",
        items: [podcastCandidate("episode-1")],
      },
    ],
    new Date("2026-08-14T08:10:00Z"),
    {
      accessToken: "token",
      stateStore: store,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({
          id: "episode-1",
          uri: "spotify:episode:episode-1",
          type: "episode",
          duration_ms: 1_000,
          resume_point: {
            fully_played: true,
            resume_position_ms: 0,
          },
        });
      },
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(result.checkedEpisodeIds, ["episode-1"]);
  assert.deepEqual(result.violations, [
    {
      targetPlaylistId: "target-1",
      targetName: "Carro",
      uri: "spotify:episode:episode-1",
      spotifyEpisodeId: "episode-1",
      reason: "COMPLETED_NO_REPLAY",
    },
  ]);
});

test("prewrite gate allows explicit replay without an unnecessary provider call", async () => {
  const store = createVolatilePodcastListeningStateStore();
  let calls = 0;

  const result = await checkPodcastCompletionBeforeWrite(
    "user-1",
    [
      {
        targetPlaylistId: "target-1",
        targetName: "Carro",
        items: [podcastCandidate("episode-1", true)],
      },
    ],
    new Date("2026-08-14T08:10:00Z"),
    {
      accessToken: "token",
      stateStore: store,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    },
  );

  assert.equal(calls, 0);
  assert.deepEqual(result.checkedEpisodeIds, []);
  assert.deepEqual(result.violations, []);
});

test("prewrite gate deduplicates provider reads across targets", async () => {
  const store = createVolatilePodcastListeningStateStore();
  let calls = 0;

  const result = await checkPodcastCompletionBeforeWrite(
    "user-1",
    [
      {
        targetPlaylistId: "target-1",
        targetName: "Carro",
        items: [podcastCandidate("episode-1")],
      },
      {
        targetPlaylistId: "target-2",
        targetName: "Casa",
        items: [podcastCandidate("episode-1")],
      },
    ],
    new Date("2026-08-14T08:10:00Z"),
    {
      accessToken: "token",
      stateStore: store,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({
          id: "episode-1",
          uri: "spotify:episode:episode-1",
          type: "episode",
          duration_ms: 1_000,
          resume_point: {
            fully_played: false,
            resume_position_ms: 0,
          },
        });
      },
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(result.checkedEpisodeIds, ["episode-1"]);
  assert.deepEqual(result.violations, []);
});

test("prewrite gate fails closed when a podcast URI cannot prove its episode identity", async () => {
  const store = createVolatilePodcastListeningStateStore();
  const malformed = {
    ...podcastCandidate("episode-1"),
    uri: "spotify:show:not-an-episode",
  };
  let calls = 0;

  const result = await checkPodcastCompletionBeforeWrite(
    "user-1",
    [
      {
        targetPlaylistId: "target-1",
        targetName: "Carro",
        items: [malformed],
      },
    ],
    new Date("2026-08-14T08:10:00Z"),
    {
      accessToken: "token",
      stateStore: store,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    },
  );

  assert.equal(calls, 0);
  assert.deepEqual(result.checkedEpisodeIds, []);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.reason, "UNVERIFIABLE_EPISODE_ID");
});
