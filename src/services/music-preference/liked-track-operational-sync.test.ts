import assert from "node:assert/strict";
import test from "node:test";

import {
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import type {
  LikedTrackInventoryItem,
  SpotifyLikedTrackInventory,
} from "./liked-track-inventory";
import {
  buildOperationalLikedTrackPlan,
  evaluateOperationalLikedTrackReconciliationSafety,
  type ExistingOperationalLikedTrack,
} from "./liked-track-operational-sync";

const NOW = new Date("2026-09-28T16:13:59.141Z");

function inventoryItem(input: {
  id: string;
  status?: "AVAILABLE" | "UNAVAILABLE" | "INVALID";
  addedAt?: string;
  title?: string;
}): LikedTrackInventoryItem {
  return {
    addedAt: input.addedAt ?? "2026-09-01T12:00:00.000Z",
    spotifyTrackId: input.id,
    effectiveSpotifyTrackId: input.id,
    uri: `spotify:track:${input.id}`,
    title: input.title ?? `Track ${input.id}`,
    primaryArtistId: `artist-${input.id}`,
    primaryArtistName: `Artist ${input.id}`,
    albumId: `album-${input.id}`,
    albumName: `Album ${input.id}`,
    durationMs: 180_000,
    status: input.status ?? "AVAILABLE",
    restrictionReason: null,
  };
}

function provider(items: LikedTrackInventoryItem[]): SpotifyLikedTrackInventory {
  return {
    items,
    pagesRead: 1,
    providerCalls: 1,
    retries: 0,
    rateLimitedCount: 0,
    retryWaitMs: 0,
  };
}

function existingTrack(input: {
  id: string;
  isLiked?: boolean;
  addedAt?: Date;
}): ExistingOperationalLikedTrack {
  return {
    id: `row-${input.id}`,
    spotifyTrackId: input.id,
    spotifyUri: `spotify:track:${input.id}`,
    trackName: `Track ${input.id}`,
    primaryArtistId: `artist-${input.id}`,
    primaryArtistName: `Artist ${input.id}`,
    albumId: `album-${input.id}`,
    albumName: `Album ${input.id}`,
    durationMs: 180_000,
    addedAt: input.addedAt ?? new Date("2026-08-01T12:00:00.000Z"),
    availability: LikedTrackAvailability.AVAILABLE,
    isLiked: input.isLiked ?? true,
    firstProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_BACKFILL,
    lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_BACKFILL,
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    unlikedAt: null,
  };
}

test("operational baseline materializes Saved Tracks without affinity plan state", () => {
  const plan = buildOperationalLikedTrackPlan(
    provider([
      inventoryItem({ id: "available" }),
      inventoryItem({ id: "unavailable", status: "UNAVAILABLE" }),
    ]),
    [],
    LikedTrackPreferenceProvenance.LIKED_TRACK_BACKFILL,
    NOW,
  );

  assert.equal(plan.beforeLikedTracks, 0);
  assert.equal(plan.afterLikedTracks, 2);
  assert.equal(plan.tracksToCreate.length, 2);
  assert.deepEqual(plan.tracksToReactivate, []);
  assert.deepEqual(plan.tracksToUnlike, []);
  assert.equal(plan.currentTracks[0]?.availability !== undefined, true);

  assert.equal("evidenceToCreate" in plan, false);
  assert.equal("affinityStatesToCreate" in plan, false);
  assert.equal("artistAffinity" in plan, false);
});

test("operational plan reactivates an existing Saved Track without profile state", () => {
  const plan = buildOperationalLikedTrackPlan(
    provider([inventoryItem({ id: "reactivate" })]),
    [existingTrack({ id: "reactivate", isLiked: false })],
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    NOW,
  );

  assert.deepEqual(plan.tracksToReactivate, ["reactivate"]);
  assert.deepEqual(plan.tracksToUnlike, []);
  assert.equal(plan.afterLikedTracks, 1);
});

test("full operational reconciliation plan marks provider removals as unlike", () => {
  const plan = buildOperationalLikedTrackPlan(
    provider([inventoryItem({ id: "kept" })]),
    [existingTrack({ id: "kept" }), existingTrack({ id: "removed" })],
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    NOW,
  );

  assert.deepEqual(plan.tracksToUnlike, ["removed"]);
  assert.equal(plan.beforeLikedTracks, 2);
  assert.equal(plan.afterLikedTracks, 1);
});

test("reconciliation circuit breaker preserves prior count and percentage limits", () => {
  assert.deepEqual(
    evaluateOperationalLikedTrackReconciliationSafety({
      beforeLikedTracks: 1000,
      tracksToUnlike: 1,
      rowsWithoutCanonicalId: 0,
    }).status,
    "READY",
  );

  const review = evaluateOperationalLikedTrackReconciliationSafety({
    beforeLikedTracks: 100,
    tracksToUnlike: 26,
    rowsWithoutCanonicalId: 0,
  });
  assert.equal(review.status, "REVIEW_REQUIRED");
  assert.equal(review.manualForceAllowed, true);
  assert.deepEqual(review.reasons.sort(), [
    "UNLIKE_COUNT_LIMIT",
    "UNLIKE_PERCENT_LIMIT",
  ]);

  const blocked = evaluateOperationalLikedTrackReconciliationSafety({
    beforeLikedTracks: 100,
    tracksToUnlike: 0,
    rowsWithoutCanonicalId: 1,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.automaticApplyAllowed, false);
});
