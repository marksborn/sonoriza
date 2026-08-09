import assert from "node:assert/strict";
import test from "node:test";

import {
  SpotifyIncrementalReader,
  type IncrementalSpotifySourceConfig,
} from "./incremental-reader";
import { createVolatilePodcastListeningStateStore } from "./podcast-listening-state";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function source(): IncrementalSpotifySourceConfig {
  return {
    id: "source-replay",
    userId: "user-replay",
    kind: "PODCAST",
    spotifyType: "SHOW",
    spotifyId: "show-replay",
    name: "Replay show",
    includePlayed: true,
    episodeOrder: "SOURCE_DEFAULT",
    spotifySnapshotId: null,
    cachedCandidates: null,
  };
}

test("completed episode replay uses the current replay remaining duration without losing sticky completion", async () => {
  const originalFetch = globalThis.fetch;
  let replaying = false;
  globalThis.fetch = (async () =>
    jsonResponse({
      items: [
        {
          id: "episode-replay",
          uri: "spotify:episode:episode-replay",
          name: "Replay episode",
          duration_ms: 100,
          type: "episode",
          resume_point: {
            fully_played: !replaying,
            resume_position_ms: replaying ? 40 : 100,
          },
        },
      ],
      next: null,
    })) as typeof fetch;

  try {
    const stateStore = createVolatilePodcastListeningStateStore();
    const Constructor = SpotifyIncrementalReader as unknown as new (
      accessToken: string,
      authoritativePodcastProgramIds?: ReadonlySet<string>,
      store?: ReturnType<typeof createVolatilePodcastListeningStateStore>,
    ) => SpotifyIncrementalReader;

    const firstReader = new Constructor("test-token", new Set(), stateStore);
    const first = await (await firstReader.createSource(source())).readNext();
    assert.equal(first.podcastCompletedCount, 1);
    assert.equal(first.candidates[0]?.durationMs, 100);

    replaying = true;
    const replayReader = new Constructor("test-token", new Set(), stateStore);
    const replay = await (await replayReader.createSource(source())).readNext();

    assert.equal(replay.podcastCompletedCount, 1);
    assert.equal(replay.candidates[0]?.resumePositionMs, 40);
    assert.equal(replay.candidates[0]?.durationMs, 60);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
