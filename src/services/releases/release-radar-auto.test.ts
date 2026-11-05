import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_RADAR_AUTO_RETRY_MS,
  refreshDueReleaseRadars,
  releaseRadarAutoRefreshDue,
} from "./release-radar-auto";

const NOW = new Date("2026-11-05T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

test("due: never fetched or past the daily interval; OFF never", () => {
  const base = { mode: "SHADOW" as const, lastAttemptAtMs: undefined, now: NOW };
  assert.equal(releaseRadarAutoRefreshDue({ ...base, fetchedAt: null }), true);
  assert.equal(releaseRadarAutoRefreshDue({ ...base, fetchedAt: hoursAgo(21) }), true);
  assert.equal(releaseRadarAutoRefreshDue({ ...base, fetchedAt: hoursAgo(19) }), false);
  assert.equal(releaseRadarAutoRefreshDue({ ...base, mode: "ACTIVE", fetchedAt: hoursAgo(21) }), true);
  assert.equal(releaseRadarAutoRefreshDue({ ...base, mode: "OFF", fetchedAt: null }), false);
});

test("a recent failed attempt waits, then retries", () => {
  const base = { mode: "ACTIVE" as const, fetchedAt: hoursAgo(30), now: NOW };
  const at = (ms: number) => NOW.getTime() - ms;
  assert.equal(releaseRadarAutoRefreshDue({ ...base, lastAttemptAtMs: at(5 * 60_000) }), false);
  assert.equal(
    releaseRadarAutoRefreshDue({ ...base, lastAttemptAtMs: at(RELEASE_RADAR_AUTO_RETRY_MS) }),
    true,
  );
});

test("consecutive ticks do not repeat a refresh that did not persist", async () => {
  let refreshes = 0;
  const attempts = new Map<string, number>();
  const deps = {
    listUserIds: async () => ["u1"],
    readFetchedAt: async () => hoursAgo(30),
    refresh: async () => {
      refreshes += 1;
      return false;
    },
  };
  assert.deepEqual(await refreshDueReleaseRadars({ now: NOW, mode: "SHADOW", deps, attempts }), {
    refreshed: 0,
    failed: 1,
  });
  const nextTick = new Date(NOW.getTime() + 5 * 60_000);
  await refreshDueReleaseRadars({ now: nextTick, mode: "SHADOW", deps, attempts });
  assert.equal(refreshes, 1);
});

test("one user's error does not stop the next, and OFF makes no call", async () => {
  const seen: string[] = [];
  const deps = {
    listUserIds: async () => ["bad", "good"],
    readFetchedAt: async () => null,
    refresh: async (userId: string) => {
      seen.push(userId);
      if (userId === "bad") throw new Error("spotify down");
      return true;
    },
  };
  assert.deepEqual(
    await refreshDueReleaseRadars({ now: NOW, mode: "ACTIVE", deps, attempts: new Map() }),
    { refreshed: 1, failed: 1 },
  );
  assert.deepEqual(seen, ["bad", "good"]);

  const off = {
    ...deps,
    listUserIds: async () => {
      throw new Error("must not run");
    },
  };
  assert.deepEqual(
    await refreshDueReleaseRadars({ now: NOW, mode: "OFF", deps: off, attempts: new Map() }),
    { refreshed: 0, failed: 0 },
  );
});

test("a failure listing users never throws into the cron", async () => {
  const deps = {
    listUserIds: async () => {
      throw new Error("db down");
    },
    readFetchedAt: async () => null,
    refresh: async () => true,
  };
  assert.deepEqual(
    await refreshDueReleaseRadars({ now: NOW, mode: "ACTIVE", deps, attempts: new Map() }),
    { refreshed: 0, failed: 1 },
  );
});
