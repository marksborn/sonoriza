import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

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
