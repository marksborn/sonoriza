import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SPOTIFY_CATALOG_CACHE_TTL,
  SpotifyCatalogCacheWriteError,
  SpotifyCatalogReadSession,
  SpotifyCatalogRequestBudgetExceededError,
  isSpotifyCatalogRequestBudgetExceededError,
  normalizeRequestBudget,
} from "./catalog-read-session";

const DAY_MS = 24 * 60 * 60 * 1000;

test("catalog read session persists successful reads across refresh runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sonoriza-catalog-cache-"));
  const now = new Date("2026-08-24T12:00:00.000Z");
  const path = "/albums/album-1/tracks?market=from_token&limit=50";

  try {
    const first = new SpotifyCatalogReadSession("user-1", {
      cacheDir: root,
      requestBudget: 2,
      now: () => now,
    });
    assert.equal(await first.readCache(path, 60_000), null);
    first.reserveNetworkRequest(path);
    await first.writeCache(path, { items: [{ id: "track-1" }] });

    const second = new SpotifyCatalogReadSession("user-1", {
      cacheDir: root,
      requestBudget: 2,
      now: () => new Date(now.getTime() + 30_000),
    });
    assert.deepEqual(await second.readCache(path, 60_000), {
      items: [{ id: "track-1" }],
    });
    assert.equal(second.getMetrics().networkRequests, 0);
    assert.equal(second.getMetrics().cacheHits, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog cache policy keeps artist album pages warm across snapshot refreshes", () => {
  assert.equal(SPOTIFY_CATALOG_CACHE_TTL.search, 7 * DAY_MS);
  assert.equal(SPOTIFY_CATALOG_CACHE_TTL.artistAlbums, 7 * DAY_MS);
  assert.equal(SPOTIFY_CATALOG_CACHE_TTL.albumTracks, 30 * DAY_MS);
});

test("catalog request budget stops locally and exposes the next cache miss", () => {
  const session = new SpotifyCatalogReadSession("user-1", {
    requestBudget: 2,
    cacheDir: "/tmp/unused-sonoriza-cache-test",
  });

  session.reserveNetworkRequest("/first");
  session.reserveNetworkRequest("/second");
  const nextPath = "/artists/artist-3/albums?include_groups=album&limit=10";

  assert.throws(
    () => session.reserveNetworkRequest(nextPath),
    (error: unknown) => {
      assert.ok(error instanceof SpotifyCatalogRequestBudgetExceededError);
      assert.equal(error.requestBudget, 2);
      assert.equal(error.networkRequests, 2);
      assert.equal(error.nextRequestPath, nextPath);
      assert.match(error.message, /Next cache miss:/);
      assert.match(error.message, /artist-3/);
      return true;
    },
  );
});

test("zero request budget enables a strict cache-only session with dry-run path", () => {
  const session = new SpotifyCatalogReadSession("user-1", {
    requestBudget: 0,
    cacheDir: "/tmp/unused-sonoriza-cache-only-test",
  });
  const nextPath = "/artists/artist-1/albums?include_groups=album&limit=10";

  assert.throws(
    () => session.reserveNetworkRequest(nextPath),
    (error: unknown) => {
      assert.ok(error instanceof SpotifyCatalogRequestBudgetExceededError);
      assert.equal(error.requestBudget, 0);
      assert.equal(error.networkRequests, 0);
      assert.equal(error.nextRequestPath, nextPath);
      assert.match(error.message, /Next cache miss:/);
      return true;
    },
  );
  assert.equal(session.getMetrics().networkRequests, 0);
});

test("catalog cache write failure is terminal and visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "sonoriza-catalog-cache-write-"));
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "block cache directory creation", "utf8");

  try {
    const session = new SpotifyCatalogReadSession("user-1", {
      cacheDir: blocker,
      requestBudget: 1,
    });

    await assert.rejects(
      session.writeCache("/artists/artist-1/albums", { items: [] }),
      (error: unknown) => {
        assert.ok(error instanceof SpotifyCatalogCacheWriteError);
        assert.equal(error.code, "SPOTIFY_CATALOG_CACHE_WRITE_FAILED");
        assert.equal(isSpotifyCatalogRequestBudgetExceededError(error), true);
        assert.match(error.message, /cache write failed/i);
        return true;
      },
    );

    assert.equal(session.getMetrics().cacheWrites, 0);
    assert.equal(session.getMetrics().cacheWriteFailures, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog request budget is clamped conservatively", () => {
  assert.equal(normalizeRequestBudget(Number.NaN), 4);
  assert.equal(normalizeRequestBudget(0), 0);
  assert.equal(normalizeRequestBudget(-5), 0);
  assert.equal(normalizeRequestBudget(8.9), 8);
  assert.equal(normalizeRequestBudget(500), 100);
});
