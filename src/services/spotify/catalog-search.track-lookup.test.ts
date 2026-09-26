import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SpotifyCatalogReadSession } from "./catalog-read-session";
import {
  SpotifyCatalogSearchClient,
  spotifyCatalogOperationForPath,
} from "./catalog-search";

type RequestJsonOverride = {
  requestJson<T>(path: string): Promise<T>;
};

function overrideRequestJson(
  client: SpotifyCatalogSearchClient,
  handler: (path: string) => Promise<unknown>,
): void {
  Object.defineProperty(client as unknown as RequestJsonOverride, "requestJson", {
    configurable: true,
    value: async <T>(path: string): Promise<T> =>
      (await handler(path)) as T,
  });
}

function spotifyTrack(id: string) {
  return {
    id,
    name: `Track ${id}`,
    uri: `spotify:track:${id}`,
    duration_ms: 180_000,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    external_ids: { isrc: `USAAA26${id.padStart(5, "0")}` },
    artists: [
      {
        id: "artist-1",
        name: "Artist",
        uri: "spotify:artist:artist-1",
        external_urls: { spotify: "https://open.spotify.com/artist/artist-1" },
      },
    ],
    album: { id: "album-1", name: "Album" },
    linked_from: null,
    is_playable: true,
    restrictions: null,
    is_local: false,
  };
}

test("lookupTracksByIds uses sequential individual track endpoints and deduplicates IDs", async () => {
  const client = await SpotifyCatalogSearchClient.forUser("catalog-track-test");
  const paths: string[] = [];

  overrideRequestJson(client, async (path) => {
    paths.push(path);
    const id = decodeURIComponent(path.slice("/tracks/".length));
    return spotifyTrack(id);
  });

  const result = await client.lookupTracksByIds([
    "track-a",
    "track-b",
    "track-a",
    "  ",
  ]);

  assert.deepEqual(paths, ["/tracks/track-a", "/tracks/track-b"]);
  assert.deepEqual(
    result.map((row) => row.requestedTrackId),
    ["track-a", "track-b"],
  );
  assert.deepEqual(
    result.map((row) => row.track?.id),
    ["track-a", "track-b"],
  );
});

test("lookupTracksByIds fails closed and stops issuing requests after a provider error", async () => {
  const client = await SpotifyCatalogSearchClient.forUser("catalog-track-fail-test");
  const paths: string[] = [];

  overrideRequestJson(client, async (path) => {
    paths.push(path);
    if (path === "/tracks/track-b") {
      throw new Error("Spotify API GET catalog-track failed (429): quota exceeded");
    }
    return spotifyTrack(path.slice("/tracks/".length));
  });

  await assert.rejects(
    client.lookupTracksByIds(["track-a", "track-b", "track-c"]),
    /429/,
  );

  assert.deepEqual(paths, ["/tracks/track-a", "/tracks/track-b"]);
});

test("lookupTracksByIds persists individual track responses across read sessions", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "sonoriza-catalog-track-"));
  t.after(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  const coldSession = new SpotifyCatalogReadSession("catalog-track-cache-user", {
    cacheDir,
    requestBudget: 10,
  });
  const coldClient = await SpotifyCatalogSearchClient.forUser(
    "catalog-track-cache-user",
    { readSession: coldSession },
  );
  const coldPaths: string[] = [];
  overrideRequestJson(coldClient, async (path) => {
    coldPaths.push(path);
    return spotifyTrack(decodeURIComponent(path.slice("/tracks/".length)));
  });

  const cold = await coldClient.lookupTracksByIds(["track-a", "track-b"]);
  assert.deepEqual(coldPaths, ["/tracks/track-a", "/tracks/track-b"]);
  assert.equal(coldSession.getMetrics().cacheWrites, 2);

  const warmSession = new SpotifyCatalogReadSession("catalog-track-cache-user", {
    cacheDir,
    requestBudget: 0,
  });
  const warmClient = await SpotifyCatalogSearchClient.forUser(
    "catalog-track-cache-user",
    { readSession: warmSession },
  );
  overrideRequestJson(warmClient, async (path) => {
    throw new Error(`warm cache unexpectedly called provider: ${path}`);
  });

  const warm = await warmClient.lookupTracksByIds(["track-a", "track-b"]);
  assert.deepEqual(
    warm.map((row) => row.track?.id),
    cold.map((row) => row.track?.id),
  );
  assert.equal(warmSession.getMetrics().cacheHits, 2);
  assert.equal(warmSession.getMetrics().networkRequests, 0);
});

test("catalog track endpoint has an explicit diagnostic operation", () => {
  assert.equal(spotifyCatalogOperationForPath("/tracks/abc123"), "catalog-track");
  assert.equal(
    spotifyCatalogOperationForPath("/tracks/abc123?market=from_token"),
    "catalog-track",
  );
  assert.equal(spotifyCatalogOperationForPath("/search?q=x&type=track"), "spotify-api");
});
