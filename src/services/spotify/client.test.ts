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

test("429 normal respects Retry-After and retries once", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(
        { error: { status: 429, message: "Too many requests" } },
        { status: 429, headers: { "Retry-After": "0" } },
      );
    }
    return jsonResponse({ id: "spotify-user" }, { status: 200 });
  }) as typeof fetch;
  Math.random = () => 0;

  try {
    const client = createClient();
    assert.equal(await client.getCurrentUserId(), "spotify-user");
    assert.equal(calls, 2);
    assert.deepEqual(client.getRequestMetrics(), {
      totalCalls: 2,
      callsByOperation: { "current-user": 2 },
      rateLimitedCount: 1,
      quotaExceededCount: 0,
      retries: 1,
      retryWaitMs: 0,
      circuitOpenSkips: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("persistent normal 429 stops after the bounded retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(
      { error: { status: 429, message: "Too many requests" } },
      { status: 429, headers: { "Retry-After": "0" } },
    );
  }) as typeof fetch;
  Math.random = () => 0;

  try {
    const client = createClient();
    await assert.rejects(client.getCurrentUserId(), (error: unknown) => {
      assert.ok(error instanceof SpotifyApiError);
      assert.equal(error.kind, "RATE_LIMITED");
      assert.equal(error.retryable, true);
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(client.getRequestMetrics().retries, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("QUOTA_EXCEEDED does not retry and opens the read circuit for the run", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(
      {
        error: {
          status: 429,
          message: "Too many requests",
          reason: "QUOTA_EXCEEDED",
        },
      },
      { status: 429 },
    );
  }) as typeof fetch;

  try {
    const client = createClient();
    await assert.rejects(client.getCurrentUserId(), (error: unknown) => {
      assert.ok(error instanceof SpotifyApiError);
      assert.equal(error.kind, "QUOTA_EXCEEDED");
      assert.equal(error.reason, "QUOTA_EXCEEDED");
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 1);

    await assert.rejects(client.getCurrentUserId(), (error: unknown) => {
      assert.ok(error instanceof SpotifyApiError);
      assert.equal(error.kind, "QUOTA_EXCEEDED");
      return true;
    });
    assert.equal(calls, 1);

    const metrics = client.getRequestMetrics();
    assert.equal(metrics.quotaExceededCount, 1);
    assert.equal(metrics.retries, 0);
    assert.equal(metrics.circuitOpenSkips, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
