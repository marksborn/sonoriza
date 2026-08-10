import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { SpotifyApiError } from "./errors";
import {
  decodeMusicSourceCache,
  decodePartialMusicSourceCache,
  encodePartialMusicSourceCache,
} from "./source-cache";
import {
  SpotifyIncrementalReader,
  type IncrementalSpotifySourceConfig,
} from "./incremental-reader";
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

function source(
  overrides: Partial<IncrementalSpotifySourceConfig> = {},
): IncrementalSpotifySourceConfig {
  return {
    id: "source-a",
    userId: "user-a",
    kind: "PODCAST",
    spotifyType: "PLAYLIST",
    spotifyId: "playlist-a",
    name: "Podcast source",
    includePlayed: false,
    episodeOrder: "SOURCE_DEFAULT",
    spotifySnapshotId: null,
    cachedCandidates: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

test("playlist podcast reads exactly one 50-item page per requested batch", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];

  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (urls.length === 1) {
      assert.match(url, /\/items\?limit=50&fields=/);
      return jsonResponse({
        items: [
          {
            item: {
              uri: "spotify:episode:1",
              name: "Episode 1",
              duration_ms: 120_000,
              type: "episode",
              is_local: false,
              show: { id: "show-1", name: "Show 1" },
              resume_point: { fully_played: false, resume_position_ms: 0 },
            },
          },
        ],
        next: "https://api.spotify.com/v1/playlists/playlist-a/items?offset=50&limit=50",
      });
    }

    return jsonResponse({
      items: [
        {
          item: {
            uri: "spotify:episode:2",
            name: "Episode 2",
            duration_ms: 120_000,
            type: "episode",
            is_local: false,
            show: { id: "show-2", name: "Show 2" },
            resume_point: { fully_played: false, resume_position_ms: 0 },
          },
        },
      ],
      next: null,
    });
  }) as typeof fetch;

  try {
    const reader = createReader();
    const cursor = await reader.createSource(source());

    const first = await cursor.readNext();
    assert.equal(first.candidates.length, 1);
    assert.equal(first.done, false);
    assert.equal(urls.length, 1);

    const second = await cursor.readNext();
    assert.equal(second.candidates.length, 1);
    assert.equal(second.done, true);
    assert.equal(urls.length, 2);
    assert.equal(reader.getRequestMetrics().sourceReads["PLAYLIST:playlist-a"]?.pagesRead, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incremental reader keeps bounded Retry-After retry semantics", async () => {
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
    return jsonResponse({ items: [], next: null });
  }) as typeof fetch;
  Math.random = () => 0;

  try {
    const reader = createReader();
    const cursor = await reader.createSource(source());
    const batch = await cursor.readNext();
    assert.equal(batch.done, true);
    assert.equal(calls, 2);
    assert.equal(reader.getRequestMetrics().retries, 1);
    assert.equal(reader.getRequestMetrics().rateLimitedCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("QUOTA_EXCEEDED opens the incremental read circuit without retry storm", async () => {
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
    const reader = createReader();
    const first = await reader.createSource(source());
    await assert.rejects(first.readNext(), (error: unknown) => {
      assert.ok(error instanceof SpotifyApiError);
      assert.equal(error.kind, "QUOTA_EXCEEDED");
      return true;
    });
    assert.equal(calls, 1);

    const second = await reader.createSource(
      source({ id: "source-b", spotifyId: "playlist-b" }),
    );
    await assert.rejects(second.readNext(), (error: unknown) => {
      assert.ok(error instanceof SpotifyApiError);
      assert.equal(error.kind, "QUOTA_EXCEEDED");
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(reader.getRequestMetrics().circuitOpenSkips, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "music cache is persisted only after full exhaustion and reused by snapshot on the next run",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `incremental-cache-${suffix}@example.test` },
    });
    const dbSource = await prisma.sourcePlaylist.create({
      data: {
        userId: user.id,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "playlist-cache",
        name: "Cache playlist",
      },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    let snapshot = "snapshot-1";
    let metadataCalls = 0;
    let itemCalls = 0;

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/playlists/playlist-cache?fields=snapshot_id")) {
        metadataCalls += 1;
        return jsonResponse({ snapshot_id: snapshot });
      }
      if (url.includes("/playlists/playlist-cache/items?")) {
        itemCalls += 1;
        return jsonResponse({
          items: [
            {
              item: {
                uri: `spotify:track:${snapshot}`,
                name: `Track ${snapshot}`,
                duration_ms: 180_000,
                is_local: false,
                type: "track",
                artists: [{ name: "Artist" }],
              },
            },
          ],
          next: null,
        });
      }
      throw new Error(`Unexpected Spotify request: ${url}`);
    }) as typeof fetch;

    try {
      const firstConfig = await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: dbSource.id },
      });
      const firstReader = createReader();
      const firstCursor = await firstReader.createSource(firstConfig);
      const firstBatch = await firstCursor.readNext();
      assert.equal(firstBatch.done, true);
      assert.equal(itemCalls, 1);
      assert.equal(metadataCalls, 2);

      const cached = await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: dbSource.id },
      });
      assert.equal(cached.spotifySnapshotId, "snapshot-1");
      assert.ok(cached.cachedCandidates);

      metadataCalls = 0;
      itemCalls = 0;
      const secondReader = createReader();
      const secondCursor = await secondReader.createSource(cached);
      const secondBatch = await secondCursor.readNext();
      assert.equal(secondBatch.fromCache, true);
      assert.equal(itemCalls, 0);
      assert.equal(metadataCalls, 1);

      snapshot = "snapshot-2";
      metadataCalls = 0;
      itemCalls = 0;
      const changedConfig = await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: dbSource.id },
      });
      const thirdReader = createReader();
      const thirdCursor = await thirdReader.createSource(changedConfig);
      const thirdBatch = await thirdCursor.readNext();
      assert.equal(thirdBatch.fromCache, undefined);
      assert.equal(itemCalls, 1);
      assert.equal(metadataCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test("music pages use the authenticated market and exclude explicitly unavailable tracks", async () => {
  const originalFetch = globalThis.fetch; const urls: string[] = []; let call = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input); urls.push(url); call += 1;
    if (call === 1 || call === 3) return jsonResponse({ snapshot_id: "snapshot-playable" });
    return jsonResponse({ items: [
      { item: { uri: "spotify:track:playable", name: "Playable", duration_ms: 180_000, type: "track", is_local: false, is_playable: true, artists: [{ name: "Artist" }] } },
      { item: { uri: "spotify:track:blocked", name: "Blocked", duration_ms: 180_000, type: "track", is_local: false, is_playable: false, restrictions: { reason: "market" }, artists: [{ name: "Artist" }] } },
      { item: { uri: "spotify:track:restricted", name: "Restricted", duration_ms: 180_000, type: "track", is_local: false, is_playable: true, restrictions: { reason: "product" }, artists: [{ name: "Artist" }] } },
      { item: { uri: "spotify:track:local", name: "Local", duration_ms: 180_000, type: "track", is_local: true, artists: [{ name: "Artist" }] } },
    ], next: null });
  }) as typeof fetch;
  try {
    const reader = createReader();
    const cursor = await reader.createSource(source({ kind: "MUSIC", spotifyType: "PLAYLIST", name: "Music source" }));
    const batch = await cursor.readNext();
    assert.deepEqual(batch.candidates.map((candidate) => candidate.uri), ["spotify:track:playable"]);
    assert.equal(batch.unavailableMusicSkippedCount, 2);
    assert.equal(urls.filter((url) => url.includes("/items?")).length, 1);
    const itemsUrl = urls.find((url) => url.includes("/items?")) ?? "";
    assert.match(itemsUrl, /market=from_token/); assert.match(itemsUrl, /is_playable/); assert.match(itemsUrl, /restrictions\(reason\)/);
  } finally { globalThis.fetch = originalFetch; }
});


integrationTest(
  "quota checkpoint resumes from the next music page instead of restarting a large playlist",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `incremental-resume-${suffix}@example.test` },
    });
    const dbSource = await prisma.sourcePlaylist.create({
      data: {
        userId: user.id,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "playlist-resume",
        name: "Resume playlist",
      },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    let mode: "quota" | "resume" = "quota";

    globalThis.fetch = (async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/playlists/playlist-resume?fields=snapshot_id")) {
        return jsonResponse({ snapshot_id: "resume-snapshot" });
      }
      if (url.includes("/playlists/playlist-resume/items?")) {
        if (mode === "quota") {
          if (url.includes("offset=50")) {
            return jsonResponse(
              { error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } },
              { status: 429 },
            );
          }
          return jsonResponse({
            items: [{ item: { uri: "spotify:track:first", name: "First", duration_ms: 180_000, is_local: false, type: "track", artists: [{ name: "Artist" }] } }],
            next: "https://api.spotify.com/v1/playlists/playlist-resume/items?offset=50&limit=50",
          });
        }
        assert.match(url, /offset=50/);
        return jsonResponse({
          items: [{ item: { uri: "spotify:track:second", name: "Second", duration_ms: 180_000, is_local: false, type: "track", artists: [{ name: "Artist" }] } }],
          next: null,
        });
      }
      throw new Error(`Unexpected Spotify request: ${url}`);
    }) as typeof fetch;

    try {
      const firstConfig = await prisma.sourcePlaylist.findUniqueOrThrow({ where: { id: dbSource.id } });
      const firstReader = createReader();
      const firstCursor = await firstReader.createSource(firstConfig);
      const firstBatch = await firstCursor.readNext();
      assert.deepEqual(firstBatch.candidates.map((item) => item.uri), ["spotify:track:first"]);
      await assert.rejects(firstCursor.readNext(), (error: unknown) => {
        assert.ok(error instanceof SpotifyApiError);
        assert.equal(error.kind, "QUOTA_EXCEEDED");
        return true;
      });

      const checkpoint = await prisma.sourcePlaylist.findUniqueOrThrow({ where: { id: dbSource.id } });
      assert.equal(checkpoint.spotifySnapshotId, "resume-snapshot");
      const partial = decodePartialMusicSourceCache(checkpoint.cachedCandidates);
      assert.ok(partial);
      assert.equal(partial.nextOffset, 50);
      assert.deepEqual(partial.candidates.map((item) => item.uri), ["spotify:track:first"]);
      assert.equal(decodeMusicSourceCache(checkpoint.cachedCandidates), null);

      mode = "resume";
      urls.length = 0;
      const secondReader = createReader();
      const secondCursor = await secondReader.createSource(checkpoint);
      const cachedBatch = await secondCursor.readNext();
      assert.equal(cachedBatch.fromCache, true);
      assert.equal(cachedBatch.done, false);
      assert.deepEqual(cachedBatch.candidates.map((item) => item.uri), ["spotify:track:first"]);
      const resumedBatch = await secondCursor.readNext();
      assert.equal(resumedBatch.done, true);
      assert.deepEqual(resumedBatch.candidates.map((item) => item.uri), ["spotify:track:second"]);
      const itemUrls = urls.filter((url) => url.includes("/items?"));
      assert.equal(itemUrls.length, 1);
      assert.match(itemUrls[0]!, /offset=50/);

      const complete = await prisma.sourcePlaylist.findUniqueOrThrow({ where: { id: dbSource.id } });
      assert.deepEqual(
        decodeMusicSourceCache(complete.cachedCandidates)?.map((item) => item.uri),
        ["spotify:track:first", "spotify:track:second"],
      );
      assert.equal(decodePartialMusicSourceCache(complete.cachedCandidates), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test("changed playlist snapshot discards a partial checkpoint and restarts from page zero", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("?fields=snapshot_id")) return jsonResponse({ snapshot_id: "new-snapshot" });
    if (url.includes("/items?")) return jsonResponse({ items: [], next: null });
    throw new Error(`Unexpected Spotify request: ${url}`);
  }) as typeof fetch;

  try {
    const partial = encodePartialMusicSourceCache(
      [{ uri: "spotify:track:old", spotifyTrackId: "old", type: "MUSIC", title: "Old", durationMs: 1 }],
      0,
      50,
    );
    const reader = createReader();
    const cursor = await reader.createSource(
      source({
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        name: "Music source",
        spotifySnapshotId: "old-snapshot",
        cachedCandidates: partial,
      }),
    );
    await cursor.readNext();
    const itemsUrl = urls.find((url) => url.includes("/items?")) ?? "";
    assert.doesNotMatch(itemsUrl, /offset=50/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
