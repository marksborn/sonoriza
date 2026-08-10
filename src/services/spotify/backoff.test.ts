import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  getActiveSpotifyBackoff,
  recordSpotifyBackoff,
  retryAfterSecondsRemaining,
  SpotifyBackoffActiveError,
  spotifyBackoffApiPayload,
} from "./backoff";
import { getSpotifyAccessToken } from "./token";

const now = new Date("2026-08-10T09:31:18.000Z");

test("remaining seconds and API payload use blockedUntil as source of truth", () => {
  const state = {
    provider: "spotify" as const,
    reason: "QUOTA_EXCEEDED" as const,
    operation: "playlist-metadata",
    retryAfterSeconds: 21178,
    blockedUntil: new Date("2026-08-10T15:24:16.000Z"),
    observedAt: now,
    updatedAt: now,
  };

  assert.equal(retryAfterSecondsRemaining(state, now), 21178);
  assert.deepEqual(spotifyBackoffApiPayload(state, now), {
    code: "SPOTIFY_BACKOFF_ACTIVE",
    reason: "QUOTA_EXCEEDED",
    operation: "playlist-metadata",
    blockedUntil: "2026-08-10T15:24:16.000Z",
    retryAfterSecondsRemaining: 21178,
  });
});

const databaseTest = process.env.SPOTIFY_BACKOFF_DB_TEST === "1" ? test : test.skip;

databaseTest("persisted provider backoff keeps the longest concurrent Retry-After", async () => {
  await clearBackoff();

  try {
    await recordSpotifyBackoff({
      reason: "RATE_LIMITED",
      operation: "recently-played",
      retryAfterSeconds: 60,
      observedAt: now,
    });
    await recordSpotifyBackoff({
      reason: "QUOTA_EXCEEDED",
      operation: "playlist-metadata",
      retryAfterSeconds: 21178,
      observedAt: now,
    });
    await recordSpotifyBackoff({
      reason: "RATE_LIMITED",
      operation: "user-playlists",
      retryAfterSeconds: 10,
      observedAt: new Date(now.getTime() + 1_000),
    });

    const active = await getActiveSpotifyBackoff(new Date(now.getTime() + 2_000));
    assert.ok(active);
    assert.equal(active.reason, "QUOTA_EXCEEDED");
    assert.equal(active.operation, "playlist-metadata");
    assert.equal(active.blockedUntil.toISOString(), "2026-08-10T15:24:16.000Z");
  } finally {
    await clearBackoff();
  }
});

databaseTest("active provider backoff stops token/API traffic before the first Spotify fetch", async () => {
  await clearBackoff();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("Spotify fetch must not run while provider backoff is active");
  }) as typeof fetch;

  try {
    await recordSpotifyBackoff({
      reason: "QUOTA_EXCEEDED",
      operation: "playlist-metadata",
      retryAfterSeconds: 3600,
      observedAt: new Date(),
    });

    await assert.rejects(getSpotifyAccessToken("any-user"), (error: unknown) => {
      assert.ok(error instanceof SpotifyBackoffActiveError);
      assert.equal(error.code, "SPOTIFY_BACKOFF_ACTIVE");
      assert.equal(error.reason, "QUOTA_EXCEEDED");
      return true;
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await clearBackoff();
  }
});

async function clearBackoff() {
  await prisma.$executeRawUnsafe(
    'DELETE FROM "ProviderBackoff" WHERE "provider" = \'spotify\'',
  );
}
