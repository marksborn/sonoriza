import assert from "node:assert/strict";
import test from "node:test";

import { createVolatilePodcastListeningStateStore } from "./podcast-listening-state";
import { refreshAuthoritativePodcastListeningStates } from "./podcast-authoritative-state";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
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
