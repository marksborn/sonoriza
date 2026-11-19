import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyClient } from "./client";

function createClient(): SpotifyClient {
  const Constructor = SpotifyClient as unknown as new (accessToken: string) => SpotifyClient;
  return new Constructor("test-token");
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("#564 followed artists: cursor pages, read-only GETs, own operation", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    return url.includes("after=")
      ? json({ artists: { items: [{ id: "a3", name: "C" }], next: null, total: 3 } })
      : json({
          artists: {
            items: [{ id: "a1", name: "A" }, { id: "a2", name: "B" }, { id: null, name: "x" }],
            next: "https://api.spotify.com/v1/me/following?type=artist&limit=50&after=a2",
            total: 3,
          },
        });
  }) as typeof fetch;

  try {
    const client = createClient();
    const result = await client.listFollowedArtists();
    assert.deepEqual(result.artists.map((artist) => artist.id), ["a1", "a2", "a3"]);
    assert.equal(result.total, 3);
    assert.equal(result.pagesRead, 2);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.deepEqual(client.getRequestMetrics().callsByOperation, { "followed-artists": 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#564 artist albums page returns the total for cost estimates", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return json({ items: [{ id: "al1", name: "Album" }], next: null, total: 37 });
  }) as typeof fetch;

  try {
    const client = createClient();
    const page = await client.getArtistAlbumsPage("artist-1", 10);
    assert.equal(page.total, 37);
    assert.equal(page.items.length, 1);
    assert.match(requested, /offset=10/);
    assert.deepEqual(client.getRequestMetrics().callsByOperation, { "artist-albums": 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
