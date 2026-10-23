import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyClient } from "./client";
import { SpotifyApiError } from "./errors";

function createClient(): SpotifyClient {
  const Constructor = SpotifyClient as unknown as new (
    accessToken: string,
  ) => SpotifyClient;
  return new Constructor("test-token");
}

function jsonResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

test("critical GET playlist metadata 502 retries once and succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ error: { status: 502, message: "Temporary upstream failure" } }, { status: 502 })
      : jsonResponse({ snapshot_id: "snapshot-ok" }, { status: 200 });
  }) as typeof fetch;
  Math.random = () => 0;
  try {
    const client = createClient();
    assert.equal(await client.getPlaylistSnapshotId("playlist-a"), "snapshot-ok");
    assert.equal(calls, 2);
    const metrics = client.getRequestMetrics();
    assert.equal(metrics.retries, 1);
    assert.equal(metrics.retryWaitMs, 1_000);
    assert.equal(metrics.criticalGet5xxRetries, 1);
    assert.equal(metrics.criticalGet5xxRecoveries, 1);
    assert.equal(metrics.callsByOperation["playlist-metadata"], 2);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("critical GET playlist-items 502 retries only the failed page", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let itemCalls = 0;
  let metadataCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/items?")) {
      itemCalls += 1;
      if (itemCalls === 1) {
        return jsonResponse({ error: { status: 502, message: "Bad gateway" } }, { status: 502 });
      }
      return jsonResponse({ items: [], next: null }, { status: 200 });
    }
    metadataCalls += 1;
    return jsonResponse({ snapshot_id: "snapshot-stable" }, { status: 200 });
  }) as typeof fetch;
  Math.random = () => 0;
  try {
    const client = createClient();
    const result = await client.getTargetPlaylistState("playlist-a");
    assert.equal(result.snapshotId, "snapshot-stable");
    assert.equal(result.items.length, 0);
    assert.equal(itemCalls, 2);
    assert.equal(metadataCalls, 2);
    assert.equal(client.getRequestMetrics().retries, 1);
    assert.equal(client.getRequestMetrics().criticalGet5xxRecoveries, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("persistent 502 stops after bounded exponential GET retries; 401/403/404 are never retried", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let status = 502;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse({ error: { status, message: "Unavailable" } }, { status });
  }) as typeof fetch;
  Math.random = () => 0;
  try {
    const client = createClient();
    await assert.rejects(client.getPlaylistSnapshotId("playlist-a"), (e: unknown) => {
      assert.ok(e instanceof SpotifyApiError);
      assert.equal(e.status, 502);
      return true;
    });
    assert.equal(calls, 4);
    assert.equal(client.getRequestMetrics().retries, 3);
    assert.equal(client.getRequestMetrics().retryWaitMs, 7_000);
    assert.equal(client.getRequestMetrics().criticalGet5xxRetries, 3);
    assert.equal(client.getRequestMetrics().criticalGet5xxRecoveries, 0);

    for (const permanentStatus of [401, 403, 404]) {
      status = permanentStatus;
      calls = 0;
      const clientPermanent = createClient();
      await assert.rejects(clientPermanent.getPlaylistSnapshotId("playlist-a"), (e: unknown) => {
        assert.ok(e instanceof SpotifyApiError);
        assert.equal(e.status, permanentStatus);
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(clientPermanent.getRequestMetrics().retries, 0);
      assert.equal(clientPermanent.getRequestMetrics().criticalGet5xxRetries, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("episode-state GET recovers after consecutive 502/503 within one request", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls <= 2) {
      return jsonResponse(
        { error: { status: calls === 1 ? 502 : 503, message: "Temporary upstream failure" } },
        { status: calls === 1 ? 502 : 503 },
      );
    }
    return jsonResponse(
      { id: "episode-1", uri: "spotify:episode:episode-1", resume_point: { fully_played: false, resume_position_ms: 0 } },
      { status: 200 },
    );
  }) as typeof fetch;
  Math.random = () => 0;
  try {
    const client = createClient();
    const episode = await client.getEpisodePlaybackState("episode-1");
    assert.equal(episode.id, "episode-1");
    assert.equal(calls, 3);
    const metrics = client.getRequestMetrics();
    assert.equal(metrics.callsByOperation["episode-state"], 3);
    assert.equal(metrics.criticalGet5xxRetries, 2);
    assert.equal(metrics.criticalGet5xxRecoveries, 1);
    assert.equal(metrics.retryWaitMs, 3_000);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("critical GET 429 follows rate-limit retry without entering 5xx backoff", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(
        { error: { status: 429, message: "Rate limited" } },
        { status: 429, headers: { "retry-after": "0" } },
      );
    }
    return jsonResponse({ snapshot_id: "snapshot-ok" }, { status: 200 });
  }) as typeof fetch;
  Math.random = () => 0;
  try {
    const client = createClient();
    assert.equal(await client.getPlaylistSnapshotId("playlist-a"), "snapshot-ok");
    assert.equal(calls, 2);
    const metrics = client.getRequestMetrics();
    assert.equal(metrics.rateLimitedCount, 1);
    assert.equal(metrics.retries, 1);
    assert.equal(metrics.criticalGet5xxRetries, 0);
    assert.equal(metrics.criticalGet5xxRecoveries, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});
