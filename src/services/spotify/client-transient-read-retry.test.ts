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
    assert.equal(metrics.retryWaitMs, 300);
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
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("persistent 502 stops after one short GET retry; 404 is never retried", async () => {
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
    assert.equal(calls, 2);
    assert.equal(client.getRequestMetrics().retries, 1);

    status = 404;
    calls = 0;
    const client404 = createClient();
    await assert.rejects(client404.getPlaylistSnapshotId("playlist-a"), (e: unknown) => {
      assert.ok(e instanceof SpotifyApiError);
      assert.equal(e.status, 404);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(client404.getRequestMetrics().retries, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

