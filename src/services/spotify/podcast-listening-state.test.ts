import assert from "node:assert/strict";
import test from "node:test";

import {
  createVolatilePodcastListeningStateStore,
  mergePodcastListeningState,
  PODCAST_LISTENING_STATE_TRANSACTION_TIMEOUT_MS,
  spotifyEpisodeIdFromUri,
} from "./podcast-listening-state";

const observedAt = new Date("2026-08-09T12:00:00.000Z");

function observation(overrides: Record<string, unknown> = {}) {
  return {
    spotifyEpisodeId: "episode-1",
    spotifyShowId: "show-a",
    spotifyUri: "spotify:episode:episode-1",
    durationMs: 100_000,
    resumePositionMs: 0,
    fullyPlayed: false,
    observedAt,
    ...overrides,
  } as const;
}

test("canonical listening-state transaction budget is above Prisma's 5s default", () => {
  assert.equal(PODCAST_LISTENING_STATE_TRANSACTION_TIMEOUT_MS, 20_000);
  assert.ok(PODCAST_LISTENING_STATE_TRANSACTION_TIMEOUT_MS > 5_000);
});

test("episode identity is derived from canonical Spotify episode URI", () => {
  assert.equal(
    spotifyEpisodeIdFromUri("spotify:episode:abc123"),
    "abc123",
  );
  assert.equal(spotifyEpisodeIdFromUri("spotify:track:abc123"), null);
});

test("zero progress is NOT_STARTED and a later observed transition becomes IN_PROGRESS", () => {
  const fresh = mergePodcastListeningState(null, observation());
  assert.equal(fresh.status, "NOT_STARTED");
  assert.equal(fresh.resumePositionMs, 0);
  assert.equal(fresh.firstProgressObservedAt, null);

  const transitionAt = new Date("2026-08-09T13:00:00.000Z");
  const progress = mergePodcastListeningState(
    fresh,
    observation({ resumePositionMs: 35_000, observedAt: transitionAt }),
  );
  assert.equal(progress.status, "IN_PROGRESS");
  assert.equal(progress.resumePositionMs, 35_000);
  assert.equal(progress.firstProgressObservedAt?.toISOString(), transitionAt.toISOString());
});

test("progress already present on the first observation records the factual observation timestamp", () => {
  const baseline = mergePodcastListeningState(
    null,
    observation({ resumePositionMs: 35_000 }),
  );

  assert.equal(baseline.status, "IN_PROGRESS");
  assert.equal(baseline.resumePositionMs, 35_000);
  assert.equal(baseline.firstProgressObservedAt?.toISOString(), observedAt.toISOString());

  const laterAt = new Date("2026-08-10T12:00:00.000Z");
  const later = mergePodcastListeningState(
    baseline,
    observation({
      resumePositionMs: 40_000,
      observedAt: laterAt,
    }),
  );

  assert.equal(later.firstProgressObservedAt?.toISOString(), observedAt.toISOString());
});

test("legacy IN_PROGRESS state without timestamp is healed by the next positive observation", () => {
  const legacy = {
    spotifyEpisodeId: "episode-1",
    spotifyShowId: "show-a",
    spotifyUri: "spotify:episode:episode-1",
    durationMs: 100_000,
    resumePositionMs: 35_000,
    fullyPlayed: false,
    status: "IN_PROGRESS" as const,
    firstProgressObservedAt: null,
    lastObservedAt: new Date("2026-08-01T12:00:00.000Z"),
  };
  const healingAt = new Date("2026-08-09T14:00:00.000Z");

  const healed = mergePodcastListeningState(
    legacy,
    observation({ resumePositionMs: 40_000, observedAt: healingAt }),
  );

  assert.equal(healed.status, "IN_PROGRESS");
  assert.equal(
    healed.firstProgressObservedAt?.toISOString(),
    healingAt.toISOString(),
  );
});

test("show provenance is sticky when later provider metadata omits show identity", () => {
  const first = mergePodcastListeningState(null, observation());
  assert.equal(first.spotifyShowId, "show-a");

  const later = mergePodcastListeningState(
    first,
    observation({ spotifyShowId: null }),
  );
  assert.equal(later.spotifyShowId, "show-a");
});

test("conflicting show provenance fails closed instead of moving an episode", () => {
  const first = mergePodcastListeningState(null, observation());
  assert.throws(
    () =>
      mergePodcastListeningState(
        first,
        observation({ spotifyShowId: "show-b" }),
      ),
    /Podcast show provenance conflict/,
  );
});

test("explicit completion records the factual observation time and becomes canonical COMPLETED", () => {
  const state = mergePodcastListeningState(
    null,
    observation({ resumePositionMs: 98_000, fullyPlayed: true }),
  );
  assert.equal(state.status, "COMPLETED");
  assert.equal(state.fullyPlayed, true);
  assert.equal(state.firstProgressObservedAt?.toISOString(), observedAt.toISOString());
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
  assert.equal(
    missing.firstProgressObservedAt?.toISOString(),
    observedAt.toISOString(),
  );
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
  assert.equal(second.firstProgressObservedAt?.toISOString(), observedAt.toISOString());
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
  assert.equal(
    resolved.get("episode-1")?.firstProgressObservedAt?.toISOString(),
    observedAt.toISOString(),
  );
});
