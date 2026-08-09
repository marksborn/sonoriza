import assert from "node:assert/strict";
import test from "node:test";

import {
  createVolatilePodcastListeningStateStore,
  mergePodcastListeningState,
  spotifyEpisodeIdFromUri,
} from "./podcast-listening-state";

const observedAt = new Date("2026-08-09T12:00:00.000Z");

function observation(overrides: Record<string, unknown> = {}) {
  return {
    spotifyEpisodeId: "episode-1",
    spotifyUri: "spotify:episode:episode-1",
    durationMs: 100_000,
    resumePositionMs: 0,
    fullyPlayed: false,
    observedAt,
    ...overrides,
  } as const;
}

test("episode identity is derived from canonical Spotify episode URI", () => {
  assert.equal(
    spotifyEpisodeIdFromUri("spotify:episode:abc123"),
    "abc123",
  );
  assert.equal(spotifyEpisodeIdFromUri("spotify:track:abc123"), null);
});

test("zero progress is NOT_STARTED and positive progress is IN_PROGRESS", () => {
  const fresh = mergePodcastListeningState(null, observation());
  assert.equal(fresh.status, "NOT_STARTED");
  assert.equal(fresh.resumePositionMs, 0);

  const progress = mergePodcastListeningState(
    fresh,
    observation({ resumePositionMs: 35_000 }),
  );
  assert.equal(progress.status, "IN_PROGRESS");
  assert.equal(progress.resumePositionMs, 35_000);
});

test("explicit completion becomes canonical COMPLETED", () => {
  const state = mergePodcastListeningState(
    null,
    observation({ resumePositionMs: 98_000, fullyPlayed: true }),
  );
  assert.equal(state.status, "COMPLETED");
  assert.equal(state.fullyPlayed, true);
});

test("COMPLETED is sticky when Spotify later resets or omits resume representation", () => {
  const completed = mergePodcastListeningState(
    null,
    observation({ resumePositionMs: 100_000, fullyPlayed: true }),
  );
  const reset = mergePodcastListeningState(
    completed,
    observation({ resumePositionMs: 0, fullyPlayed: false }),
  );
  const missing = mergePodcastListeningState(
    reset,
    observation({ resumePositionMs: null, fullyPlayed: null }),
  );

  assert.equal(reset.status, "COMPLETED");
  assert.equal(missing.status, "COMPLETED");
  assert.equal(missing.fullyPlayed, true);
});

test("partial progress does not regress on a smaller provider resume position", () => {
  const first = mergePodcastListeningState(
    null,
    observation({ resumePositionMs: 60_000 }),
  );
  const second = mergePodcastListeningState(
    first,
    observation({ resumePositionMs: 10_000 }),
  );

  assert.equal(second.status, "IN_PROGRESS");
  assert.equal(second.resumePositionMs, 60_000);
});

test("volatile store preserves canonical state across observations without mixing music history", async () => {
  const store = createVolatilePodcastListeningStateStore();
  await store.observe("user-a", [
    observation({ resumePositionMs: 45_000 }),
  ]);
  const resolved = await store.observe("user-a", [
    observation({ resumePositionMs: null, fullyPlayed: null }),
  ]);

  assert.equal(resolved.get("episode-1")?.status, "IN_PROGRESS");
  assert.equal(resolved.get("episode-1")?.resumePositionMs, 45_000);
});
