import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyIncrementalReader, type IncrementalSpotifySourceConfig } from "./incremental-reader";
import { createVolatilePodcastListeningStateStore } from "./podcast-listening-state";
import { sortShowCandidates } from "./podcast-show-policy";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function reader(authoritative: ReadonlySet<string> = new Set()): SpotifyIncrementalReader {
  const Constructor = SpotifyIncrementalReader as unknown as new (
    accessToken: string,
    authoritativePodcastProgramIds?: ReadonlySet<string>,
    stateStore?: ReturnType<typeof createVolatilePodcastListeningStateStore>,
  ) => SpotifyIncrementalReader;
  return new Constructor(
    "test-token",
    authoritative,
    createVolatilePodcastListeningStateStore(),
  );
}

function source(overrides: Partial<IncrementalSpotifySourceConfig> = {}): IncrementalSpotifySourceConfig {
  return {
    id: "source-a",
    userId: "user-a",
    kind: "PODCAST",
    spotifyType: "SHOW",
    spotifyId: "show-a",
    name: "Show A",
    includePlayed: false,
    episodeOrder: "OLDEST_FIRST",
    spotifySnapshotId: null,
    cachedCandidates: null,
    ...overrides,
  };
}

test("OLDEST_FIRST and NEWEST_FIRST sort by release metadata with stable URI tie-break", () => {
  const candidates = [
    { uri: "spotify:episode:b", type: "PODCAST" as const, title: "B", programId: "show-a", durationMs: 1, releaseDate: "2024", releaseDatePrecision: "year" },
    { uri: "spotify:episode:c", type: "PODCAST" as const, title: "C", programId: "show-a", durationMs: 1, releaseDate: "2024-05", releaseDatePrecision: "month" },
    { uri: "spotify:episode:a", type: "PODCAST" as const, title: "A", programId: "show-a", durationMs: 1, releaseDate: "2024-05", releaseDatePrecision: "month" },
    { uri: "spotify:episode:d", type: "PODCAST" as const, title: "D", programId: "show-a", durationMs: 1, releaseDate: "2025-01-01", releaseDatePrecision: "day" },
  ];
  assert.deepEqual(sortShowCandidates(candidates, "OLDEST_FIRST").map((c) => c.uri), [
    "spotify:episode:b", "spotify:episode:a", "spotify:episode:c", "spotify:episode:d",
  ]);
  assert.deepEqual(sortShowCandidates(candidates, "NEWEST_FIRST").map((c) => c.uri), [
    "spotify:episode:d", "spotify:episode:a", "spotify:episode:c", "spotify:episode:b",
  ]);
});

test("explicit SHOW order reads all pages before releasing globally sorted candidates", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ items: [
      { uri: "spotify:episode:new", name: "New", duration_ms: 100, type: "episode", release_date: "2025-01-01", release_date_precision: "day", resume_point: { fully_played: false, resume_position_ms: 0 } },
    ], next: "https://api.spotify.com/v1/shows/show-a/episodes?offset=50&limit=50" });
    return jsonResponse({ items: [
      { uri: "spotify:episode:old", name: "Old", duration_ms: 100, type: "episode", release_date: "2020", release_date_precision: "year", resume_point: { fully_played: false, resume_position_ms: 0 } },
    ], next: null });
  }) as typeof fetch;
  try {
    const cursor = await reader().createSource(source());
    const batch = await cursor.readNext();
    assert.equal(batch.done, true);
    assert.equal(calls, 2);
    assert.deepEqual(batch.candidates.map((c) => c.uri), ["spotify:episode:old", "spotify:episode:new"]);
    assert.ok(batch.candidates.every((c) => c.programId === "show-a"));
    assert.ok(batch.candidates.every((c) => c.sourceSpotifyType === "SHOW"));
  } finally { globalThis.fetch = originalFetch; }
});

test("authoritative SHOW suppresses same-program candidates from SAVED_EPISODES before playback policy can be bypassed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ items: [
    { episode: { uri: "spotify:episode:e1", name: "E1", duration_ms: 100, type: "episode", show: { id: "show-a", name: "Show A" }, resume_point: { fully_played: true, resume_position_ms: 100 } } },
    { episode: { uri: "spotify:episode:y1", name: "Y1", duration_ms: 100, type: "episode", show: { id: "show-y", name: "Show Y" }, resume_point: { fully_played: false, resume_position_ms: 0 } } },
  ], next: null })) as typeof fetch;
  try {
    const cursor = await reader(new Set(["show-a"])).createSource(source({ spotifyType: "SAVED_EPISODES", spotifyId: "me", episodeOrder: "SOURCE_DEFAULT" }));
    const batch = await cursor.readNext();
    assert.deepEqual(batch.candidates.map((c) => c.uri), ["spotify:episode:y1"]);
    assert.equal(batch.genericPodcastSuppressedCount, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("includePlayed=false keeps partially played episode first in OLDEST_FIRST while completed episode stays out", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ items: [
    { uri: "spotify:episode:e3", name: "E3", duration_ms: 100, type: "episode", release_date: "2023-01-01", release_date_precision: "day", resume_point: { fully_played: false, resume_position_ms: 0 } },
    { uri: "spotify:episode:e1", name: "E1", duration_ms: 100, type: "episode", release_date: "2021-01-01", release_date_precision: "day", resume_point: { fully_played: true, resume_position_ms: 100 } },
    { uri: "spotify:episode:e2", name: "E2", duration_ms: 100, type: "episode", release_date: "2022-01-01", release_date_precision: "day", resume_point: { fully_played: false, resume_position_ms: 40 } },
  ], next: null })) as typeof fetch;
  try {
    const cursor = await reader().createSource(source());
    const batch = await cursor.readNext();
    assert.deepEqual(batch.candidates.map((c) => c.uri), ["spotify:episode:e2", "spotify:episode:e3"]);
    assert.equal(batch.candidates[0]?.durationMs, 60);
    assert.equal(batch.fullyPlayedSkippedCount, 1);
    assert.equal(batch.podcastCompletedCount, 1);
    assert.equal(batch.podcastInProgressCount, 1);
    assert.equal(batch.podcastNotStartedCount, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("canonical completion stays excluded when a later Spotify response resets resume state", async () => {
  const originalFetch = globalThis.fetch;
  let completed = true;
  globalThis.fetch = (async () => jsonResponse({ items: [
    { uri: "spotify:episode:e1", name: "E1", duration_ms: 100, type: "episode", release_date: "2021-01-01", release_date_precision: "day", resume_point: { fully_played: completed, resume_position_ms: completed ? 100 : 0 } },
  ], next: null })) as typeof fetch;

  try {
    const stateStore = createVolatilePodcastListeningStateStore();
    const Constructor = SpotifyIncrementalReader as unknown as new (
      accessToken: string,
      authoritativePodcastProgramIds?: ReadonlySet<string>,
      store?: ReturnType<typeof createVolatilePodcastListeningStateStore>,
    ) => SpotifyIncrementalReader;

    const firstReader = new Constructor("test-token", new Set(), stateStore);
    const first = await (await firstReader.createSource(source())).readNext();
    assert.equal(first.candidates.length, 0);
    assert.equal(first.podcastCompletedCount, 1);

    completed = false;
    const secondReader = new Constructor("test-token", new Set(), stateStore);
    const second = await (await secondReader.createSource(source())).readNext();
    assert.equal(second.candidates.length, 0);
    assert.equal(second.podcastCompletedCount, 1);
    assert.equal(second.fullyPlayedSkippedCount, 1);
  } finally { globalThis.fetch = originalFetch; }
});
