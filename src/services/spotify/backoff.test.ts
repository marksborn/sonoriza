import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  getActiveSpotifyBackoff,
  recordSpotifyBackoff,
  retryAfterSecondsRemaining,
  spotifyBackoffApiPayload,
} from "./backoff";

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
  await prisma.$executeRawUnsafe('DELETE FROM "ProviderBackoff" WHERE "provider" = \'spotify\'');

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
    await prisma.$executeRawUnsafe('DELETE FROM "ProviderBackoff" WHERE "provider" = \'spotify\'');
  }
});
