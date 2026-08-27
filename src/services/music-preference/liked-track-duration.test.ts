import assert from "node:assert/strict";
import test from "node:test";

import { buildLikedTrackDurationPlan } from "./liked-track-duration";
import type { SpotifyLikedTrackInventory } from "./liked-track-inventory";

function provider(
  items: SpotifyLikedTrackInventory["items"],
): SpotifyLikedTrackInventory {
  return {
    items,
    pagesRead: 1,
    providerCalls: 1,
    retries: 0,
    rateLimitedCount: 0,
    retryWaitMs: 0,
  };
}

function item(
  spotifyTrackId: string | null,
  durationMs: number | null,
): SpotifyLikedTrackInventory["items"][number] {
  return {
    addedAt: "2026-08-27T00:00:00.000Z",
    spotifyTrackId,
    effectiveSpotifyTrackId: spotifyTrackId,
    uri: spotifyTrackId ? `spotify:track:${spotifyTrackId}` : null,
    title: spotifyTrackId ? `Track ${spotifyTrackId}` : null,
    primaryArtistId: "artist-1",
    primaryArtistName: "Artist",
    albumId: "album-1",
    albumName: "Album",
    durationMs,
    status: "AVAILABLE",
    restrictionReason: null,
  };
}

test("buildLikedTrackDurationPlan backfills only active canonical likes", () => {
  const plan = buildLikedTrackDurationPlan(
    provider([
      item("a", 180_000),
      item("b", 200_000),
      item("c", null),
      item("provider-only", 210_000),
      item(null, 999_000),
    ]),
    [
      { spotifyTrackId: "a", durationMs: null, isLiked: true },
      { spotifyTrackId: "b", durationMs: 200_000, isLiked: true },
      { spotifyTrackId: "c", durationMs: null, isLiked: true },
      { spotifyTrackId: "missing", durationMs: null, isLiked: true },
      { spotifyTrackId: "provider-only", durationMs: null, isLiked: false },
    ],
  );

  assert.equal(plan.providerCanonicalTracks, 4);
  assert.equal(plan.providerTracksWithDuration, 3);
  assert.equal(plan.activeLikedTracks, 4);
  assert.equal(plan.beforeWithDuration, 1);
  assert.deepEqual(plan.updates, [{ spotifyTrackId: "a", durationMs: 180_000 }]);
  assert.equal(plan.unchangedWithDuration, 1);
  assert.equal(plan.missingProviderTrack, 1);
  assert.equal(plan.missingProviderDuration, 1);
  assert.equal(plan.afterWithDuration, 2);
  assert.equal(plan.coveragePercent, 50);
});

test("buildLikedTrackDurationPlan is idempotent when duration already matches", () => {
  const plan = buildLikedTrackDurationPlan(
    provider([item("a", 180_000), item("b", 200_000)]),
    [
      { spotifyTrackId: "a", durationMs: 180_000, isLiked: true },
      { spotifyTrackId: "b", durationMs: 200_000, isLiked: true },
    ],
  );

  assert.equal(plan.updates.length, 0);
  assert.equal(plan.beforeWithDuration, 2);
  assert.equal(plan.afterWithDuration, 2);
  assert.equal(plan.coveragePercent, 100);
});
