import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyApiError } from "./errors";
import {
  SpotifyIncrementalReader,
  type IncrementalSpotifySourceConfig,
} from "./incremental-reader";
import {
  readPodcastLocalProcessingReason,
} from "./podcast-listening-state-diagnostics";
import { createVolatilePodcastListeningStateStore } from "./podcast-listening-state";

function createReader(): SpotifyIncrementalReader {
  const Constructor = SpotifyIncrementalReader as unknown as new (
    accessToken: string,
    authoritativePodcastProgramIds?: ReadonlySet<string>,
    stateStore?: ReturnType<typeof createVolatilePodcastListeningStateStore>,
  ) => SpotifyIncrementalReader;

  return new Constructor(
    "test-token",
    new Set(),
    createVolatilePodcastListeningStateStore(),
  );
}

function showSource(
  overrides: Partial<IncrementalSpotifySourceConfig> = {},
): IncrementalSpotifySourceConfig {
  return {
    id: "show-source",
    userId: "user-a",
    kind: "PODCAST",
    spotifyType: "SHOW",
    spotifyId: "show-a",
    name: "Show A",
    includePlayed: false,
    episodeOrder: "SOURCE_DEFAULT",
    spotifySnapshotId: null,
    cachedCandidates: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("SHOW ignores null and malformed episode entries while keeping valid episodes", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    jsonResponse({
      items: [
        null,
        {},
        { uri: "", name: "Invalid", duration_ms: 1, type: "episode" },
        {
          id: "episode-1",
          uri: "spotify:episode:episode-1",
          name: "Episode 1",
          duration_ms: 120_000,
          type: "episode",
          show: { id: "show-a", name: "Show A" },
          resume_point: { fully_played: false, resume_position_ms: 0 },
        },
      ],
      next: null,
    })) as typeof fetch;

  try {
    const reader = createReader();
    const cursor = await reader.createSource(showSource());
    const batch = await cursor.readNext();

    assert.equal(batch.done, true);
    assert.deepEqual(
      batch.candidates.map((candidate) => candidate.uri),
      ["spotify:episode:episode-1"],
    );
    assert.equal(
      reader.getRequestMetrics().sourceReads["SHOW:show-a"]?.pagesRead,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SHOW classifies a malformed items container as NORMALIZE_EPISODES", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    jsonResponse({
      items: null,
      next: null,
    })) as typeof fetch;

  try {
    const reader = createReader();
    const cursor = await reader.createSource(showSource());

    await assert.rejects(cursor.readNext(), (error: unknown) => {
      assert.ok(error instanceof SpotifyApiError);
      assert.equal(error.kind, "LOCAL_PROCESSING_ERROR");
      assert.equal(error.status, 0);
      assert.equal(error.method, "LOCAL");
      assert.equal(error.operation, "normalize-episodes");

      const diagnostic = readPodcastLocalProcessingReason(error.reason);
      assert.deepEqual(diagnostic, {
        phase: "NORMALIZE_EPISODES",
        errorName: "TypeError",
        errorCode: null,
      });
      return true;
    });

    assert.equal(
      reader.getRequestMetrics().sourceReads["SHOW:show-a"]?.pagesRead,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
