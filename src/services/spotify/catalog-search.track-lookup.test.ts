import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyCatalogSearchClient } from "./catalog-search";

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
      throw new Error("Spotify API GET spotify-api failed (429): quota exceeded");
    }
    return spotifyTrack(path.slice("/tracks/".length));
  });

  await assert.rejects(
    client.lookupTracksByIds(["track-a", "track-b", "track-c"]),
    /429/,
  );

  assert.deepEqual(paths, ["/tracks/track-a", "/tracks/track-b"]);
});
