import assert from "node:assert/strict";
import test from "node:test";

import {
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import {
  buildLikedTrackAffinityPlan,
  type ExistingLikedTrackAffinityState,
} from "@/services/music-preference/liked-track-affinity";
import type {
  LikedTrackInventoryItem,
  SpotifyLikedTrackInventory,
} from "@/services/music-preference/liked-track-inventory";

const NOW = new Date("2026-08-27T20:00:00.000Z");
const PROVENANCE = LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC;

function inventoryItem(durationMs: number | null): LikedTrackInventoryItem {
  return {
    addedAt: "2026-08-27T19:55:00.000Z",
    spotifyTrackId: "track-1",
    effectiveSpotifyTrackId: "track-1",
    uri: "spotify:track:track-1",
    title: "Track One",
    primaryArtistId: "artist-1",
    primaryArtistName: "Artist One",
    albumId: "album-1",
    albumName: "Album One",
    durationMs,
    status: "AVAILABLE",
    restrictionReason: null,
  };
}

function provider(durationMs: number | null): SpotifyLikedTrackInventory {
  return {
    items: [inventoryItem(durationMs)],
    pagesRead: 1,
    providerCalls: 1,
    retries: 0,
    rateLimitedCount: 0,
    retryWaitMs: 0,
  };
}

function existing(durationMs: number | null | undefined): ExistingLikedTrackAffinityState {
  return {
    tracks: [
      {
        id: "liked-1",
        spotifyTrackId: "track-1",
        spotifyUri: "spotify:track:track-1",
        trackName: "Track One",
        primaryArtistId: "artist-1",
        primaryArtistName: "Artist One",
        albumId: "album-1",
        albumName: "Album One",
        addedAt: new Date("2026-08-27T19:55:00.000Z"),
        durationMs,
        isLiked: true,
        availability: LikedTrackAvailability.AVAILABLE,
      },
    ],
    evidence: [],
    affinityStates: [],
  };
}

test("new canonical liked track keeps provider duration in the persisted plan", () => {
  const plan = buildLikedTrackAffinityPlan(
    provider(203_456),
    { tracks: [], evidence: [], affinityStates: [] },
    PROVENANCE,
    NOW,
  );

  assert.equal(plan.tracksToCreate.length, 1);
  assert.equal(plan.tracksToCreate[0]?.durationMs, 203_456);
});

test("missing or changed duration is a metadata update and equal duration is idempotent", () => {
  const missingDuration = buildLikedTrackAffinityPlan(
    provider(203_456),
    existing(null),
    PROVENANCE,
    NOW,
  );
  assert.equal(missingDuration.trackMetadataUpdates.length, 1);
  assert.equal(missingDuration.trackMetadataUpdates[0]?.durationMs, 203_456);

  const changedDuration = buildLikedTrackAffinityPlan(
    provider(203_456),
    existing(190_000),
    PROVENANCE,
    NOW,
  );
  assert.equal(changedDuration.trackMetadataUpdates.length, 1);
  assert.equal(changedDuration.trackMetadataUpdates[0]?.durationMs, 203_456);

  const sameDuration = buildLikedTrackAffinityPlan(
    provider(203_456),
    existing(203_456),
    PROVENANCE,
    NOW,
  );
  assert.equal(sameDuration.trackMetadataUpdates.length, 0);
});
