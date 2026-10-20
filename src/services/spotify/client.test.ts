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
      cacheHits: 0,
      cacheMisses: 0,
      memoizedReadHits: 0,
      sourceReads: {},
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

test("playlist snapshot lookup is classified separately from item pagination", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse({ snapshot_id: "snapshot-1" }, { status: 200 });
  }) as typeof fetch;

  try {
    const client = createClient();
    assert.equal(await client.getPlaylistSnapshotId("playlist-a"), "snapshot-1");
    assert.equal(calls, 1);
    assert.deepEqual(client.getRequestMetrics().callsByOperation, {
      "playlist-metadata": 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identical source reads are memoized once per SpotifyClient run", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(
      {
        items: [
          {
            uri: "spotify:episode:one",
            name: "Episode one",
            duration_ms: 60_000,
            type: "episode",
            show: { id: "show-a", name: "Show A" },
            resume_point: { fully_played: false, resume_position_ms: 0 },
          },
        ],
        next: null,
      },
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const client = createClient();
    const first = await client.getShowEpisodes("show-a");
    const second = await client.getShowEpisodes("show-a");

    assert.deepEqual(second, first);
    assert.equal(calls, 1);

    const metrics = client.getRequestMetrics();
    assert.equal(metrics.memoizedReadHits, 1);
    assert.equal(metrics.sourceReads["SHOW:show-a"]?.pagesRead, 1);
    assert.equal(metrics.sourceReads["SHOW:show-a"]?.memoizedHits, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("#435 Gate 3D Spotify GET timeout is classified and audit-friendly", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = process.env.SPOTIFY_READ_TIMEOUT_MS;
  process.env.SPOTIFY_READ_TIMEOUT_MS = "20";

  globalThis.fetch = (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("aborted")),
        { once: true },
      );
    });
  }) as typeof fetch;

  try {
    const client = createClient();
    await assert.rejects(client.getCurrentUserId(), (error: unknown) => {
      assert.ok(error instanceof SpotifyApiError);
      assert.equal(error.kind, "READ_TIMEOUT");
      assert.equal(error.status, 0);
      assert.equal(error.operation, "current-user");
      assert.equal(error.reason, "READ_TIMEOUT");
      assert.equal(error.retryable, true);
      assert.match(error.message, /timed out after 20ms/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.SPOTIFY_READ_TIMEOUT_MS;
    else process.env.SPOTIFY_READ_TIMEOUT_MS = originalTimeout;
  }
});

test("#435 Gate 3H Spotify write timeout is classified as ambiguous and never retried", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = process.env.SPOTIFY_WRITE_TIMEOUT_MS;
  process.env.SPOTIFY_WRITE_TIMEOUT_MS = "20";
  // AbortSignal.timeout() is unref'd; keep the loop alive while the mocked
  // write hangs (production has the open socket doing this).
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));

  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    assert.equal(init?.method, "POST");
    const signal = init?.signal;
    assert.ok(signal, "writes must carry an abort signal");
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("aborted")),
        { once: true },
      );
    });
  }) as typeof fetch;

  try {
    const client = createClient();
    await assert.rejects(
      client.appendPlaylistItems("playlist-a", ["spotify:track:a"]),
      (error: unknown) => {
        assert.ok(error instanceof SpotifyApiError);
        assert.equal(error.kind, "WRITE_TIMEOUT");
        assert.equal(error.reason, "WRITE_TIMEOUT");
        assert.equal(error.retryable, false);
        assert.match(error.message, /timed out after 20ms; the write outcome is unknown/);
        return true;
      },
    );
    assert.equal(calls, 1, "an ambiguous write must not be retried in-process");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.SPOTIFY_WRITE_TIMEOUT_MS;
    else process.env.SPOTIFY_WRITE_TIMEOUT_MS = originalTimeout;
  }
});
