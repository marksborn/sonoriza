import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  SpotifyIncrementalReader,
  type IncrementalSpotifySourceConfig,
} from "./incremental-reader";
import {
  prismaPodcastListeningStateStore,
  type PodcastListeningStateStore,
} from "./podcast-listening-state";

function createReader(): SpotifyIncrementalReader {
  const Constructor = SpotifyIncrementalReader as unknown as new (
    accessToken: string,
    authoritativePodcastProgramIds?: ReadonlySet<string>,
    stateStore?: PodcastListeningStateStore,
  ) => SpotifyIncrementalReader;
  return new Constructor(
    "test-token",
    new Set(),
    prismaPodcastListeningStateStore,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function episode(id: string) {
  return {
    id,
    uri: `spotify:episode:${id}`,
    name: `Episode ${id}`,
    duration_ms: 120_000,
    type: "episode",
    is_local: false,
    is_playable: true,
    show: { id: "show-cache", name: "Cached Show" },
    release_date: "2026-09-25",
    release_date_precision: "day",
    resume_point: { fully_played: false, resume_position_ms: 0 },
  };
}

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "SHOW catalog cold/warm/expired/invalid cache preserves candidates and avoids warm provider pages",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `show-cache-${suffix}@example.test` },
    });
    const dbSource = await prisma.sourcePlaylist.create({
      data: {
        userId: user.id,
        kind: "PODCAST",
        spotifyType: "SHOW",
        spotifyId: "show-cache",
        name: "Cached Show",
        includePlayed: false,
      },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    let mode: "cold" | "expired" | "invalid" | "forbid" = "cold";

    globalThis.fetch = (async (input) => {
      const url = String(input);
      providerCalls += 1;
      if (mode === "forbid") {
        throw new Error(`Warm cache unexpectedly called Spotify: ${url}`);
      }

      if (mode === "cold") {
        if (providerCalls === 1) {
          return jsonResponse({
            items: [episode("1")],
            next: "https://api.spotify.com/v1/shows/show-cache/episodes?limit=50&offset=50",
          });
        }
        return jsonResponse({ items: [episode("2")], next: null });
      }

      return jsonResponse({
        items: [episode("1"), episode("2")],
        next: null,
      });
    }) as typeof fetch;

    try {
      const coldConfig = (await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: dbSource.id },
      })) as IncrementalSpotifySourceConfig;
      const coldReader = createReader();
      const coldCursor = await coldReader.createSource(coldConfig);
      const coldBatch = await coldCursor.readNext();
      assert.deepEqual(
        coldBatch.candidates.map((candidate) => candidate.uri),
        ["spotify:episode:1", "spotify:episode:2"],
      );
      assert.equal(providerCalls, 2);
      assert.equal(coldReader.getRequestMetrics().showCatalogCacheMisses, 1);
      assert.equal(coldReader.getRequestMetrics().showCatalogCacheWrites, 1);

      const cached = await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: dbSource.id },
      });
      assert.ok(cached.cachedCandidates);
      assert.ok(cached.cacheUpdatedAt);

      providerCalls = 0;
      mode = "forbid";
      const warmReader = createReader();
      const warmCursor = await warmReader.createSource(
        cached as IncrementalSpotifySourceConfig,
      );
      const warmBatch = await warmCursor.readNext();
      assert.equal(warmBatch.fromCache, true);
      assert.deepEqual(
        warmBatch.candidates.map((candidate) => candidate.uri),
        coldBatch.candidates.map((candidate) => candidate.uri),
      );
      assert.equal(providerCalls, 0);
      assert.equal(warmReader.getRequestMetrics().totalCalls, 0);
      assert.equal(warmReader.getRequestMetrics().showCatalogCacheHits, 1);
      assert.equal(warmReader.getRequestMetrics().showCatalogPagesAvoided, 2);
      assert.equal(
        warmReader.getRequestMetrics().sourceReads["SHOW:show-cache"]?.pagesAvoided,
        2,
      );

      await prisma.sourcePlaylist.update({
        where: { id: dbSource.id },
        data: { cacheUpdatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      providerCalls = 0;
      mode = "expired";
      const expiredConfig = (await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: dbSource.id },
      })) as IncrementalSpotifySourceConfig;
      const expiredReader = createReader();
      const expiredCursor = await expiredReader.createSource(expiredConfig);
      await expiredCursor.readNext();
      assert.equal(providerCalls, 1);
      assert.equal(expiredReader.getRequestMetrics().showCatalogCacheMisses, 1);

      await prisma.sourcePlaylist.update({
        where: { id: dbSource.id },
        data: {
          cachedCandidates: { broken: true },
          cacheUpdatedAt: new Date(),
        },
      });
      providerCalls = 0;
      mode = "invalid";
      const invalidConfig = (await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: dbSource.id },
      })) as IncrementalSpotifySourceConfig;
      const invalidReader = createReader();
      const invalidCursor = await invalidReader.createSource(invalidConfig);
      await invalidCursor.readNext();
      assert.equal(providerCalls, 1);
      assert.equal(invalidReader.getRequestMetrics().showCatalogCacheMisses, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

integrationTest(
  "expired SHOW catalog refreshes from one page and falls back to a full read when unproven",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `show-delta-${suffix}@example.test` },
    });
    const dbSource = await prisma.sourcePlaylist.create({
      data: {
        userId: user.id, kind: "PODCAST", spotifyType: "SHOW", spotifyId: "show-cache",
        name: "Cached Show", includePlayed: false,
      },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    const nextPage = "https://api.spotify.com/v1/shows/show-cache/episodes?limit=50&offset=50";
    let calls = 0;
    let pages: unknown[] = [];
    globalThis.fetch = (async () => {
      const body = pages[Math.min(calls, pages.length - 1)];
      calls += 1;
      return jsonResponse(body);
    }) as typeof fetch;

    const read = async () => {
      const config = (await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: dbSource.id },
      })) as IncrementalSpotifySourceConfig;
      const reader = createReader();
      const batch = await (await reader.createSource(config)).readNext();
      return { batch, metrics: reader.getRequestMetrics() };
    };
    const expire = () =>
      prisma.sourcePlaylist.update({
        where: { id: dbSource.id },
        data: { cacheUpdatedAt: new Date(Date.now() - 2 * 86_400_000) },
      });
    const uris = (batch: Awaited<ReturnType<typeof read>>["batch"]) =>
      batch.candidates.map((candidate) => candidate.uri).sort();

    try {
      pages = [
        { items: [episode("3"), episode("2")], next: nextPage, total: 3 },
        { items: [episode("1")], next: null, total: 3 },
      ];
      await read();
      assert.equal(calls, 2);

      await expire();
      calls = 0;
      pages = [{ items: [episode("4"), episode("3"), episode("2")], next: nextPage, total: 4 }];
      const delta = await read();
      assert.equal(calls, 1, "one page instead of the whole show");
      assert.equal(delta.batch.fromCache, true);
      assert.deepEqual(uris(delta.batch), ["1", "2", "3", "4"].map((id) => `spotify:episode:${id}`));
      assert.equal(delta.metrics.showCatalogPagesAvoided, 1);

      await expire();
      calls = 0;
      pages = [
        { items: [episode("4"), episode("3")], next: nextPage, total: 3 },
        { items: [episode("1")], next: null, total: 3 },
      ];
      const full = await read();
      assert.equal(calls, 2, "a removed episode forces the full read");
      assert.deepEqual(uris(full.batch), ["1", "3", "4"].map((id) => `spotify:episode:${id}`));
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
