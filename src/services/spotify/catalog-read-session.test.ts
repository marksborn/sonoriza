import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SpotifyCatalogReadSession,
  SpotifyCatalogRequestBudgetExceededError,
  normalizeRequestBudget,
} from "./catalog-read-session";

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
    first.reserveNetworkRequest();
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

test("catalog request budget stops locally before another network request", () => {
  const session = new SpotifyCatalogReadSession("user-1", {
    requestBudget: 2,
    cacheDir: "/tmp/unused-sonoriza-cache-test",
  });

  session.reserveNetworkRequest();
  session.reserveNetworkRequest();

  assert.throws(
    () => session.reserveNetworkRequest(),
    (error: unknown) => {
      assert.ok(error instanceof SpotifyCatalogRequestBudgetExceededError);
      assert.equal(error.requestBudget, 2);
      assert.equal(error.networkRequests, 2);
      return true;
    },
  );
});

test("zero request budget enables a strict cache-only session", () => {
  const session = new SpotifyCatalogReadSession("user-1", {
    requestBudget: 0,
    cacheDir: "/tmp/unused-sonoriza-cache-only-test",
  });

  assert.throws(
    () => session.reserveNetworkRequest(),
    (error: unknown) => {
      assert.ok(error instanceof SpotifyCatalogRequestBudgetExceededError);
      assert.equal(error.requestBudget, 0);
      assert.equal(error.networkRequests, 0);
      return true;
    },
  );
  assert.equal(session.getMetrics().networkRequests, 0);
});

test("catalog request budget is clamped conservatively", () => {
  assert.equal(normalizeRequestBudget(Number.NaN), 8);
  assert.equal(normalizeRequestBudget(0), 0);
  assert.equal(normalizeRequestBudget(-5), 0);
  assert.equal(normalizeRequestBudget(8.9), 8);
  assert.equal(normalizeRequestBudget(500), 100);
});
