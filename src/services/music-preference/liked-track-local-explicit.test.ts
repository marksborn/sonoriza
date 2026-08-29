import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtistAffinityEvidenceType,
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import {
  buildLikedTrackAffinityPlan,
  type ExistingLikedTrackAffinityState,
} from "./liked-track-affinity";
import type { SpotifyLikedTrackInventory } from "./liked-track-inventory";

const NOW = new Date("2026-08-29T19:45:00.000Z");

function emptyProvider(): SpotifyLikedTrackInventory {
  return {
    items: [],
    pagesRead: 1,
    providerCalls: 1,
    retries: 0,
    rateLimitedCount: 0,
    retryWaitMs: 0,
  };
}

function existing(isLiked = true): ExistingLikedTrackAffinityState {
  return {
    tracks: [
      {
        id: "liked-local",
        spotifyTrackId: "track-local",
        spotifyUri: "spotify:track:track-local",
        trackName: "Local Explicit Track",
        primaryArtistId: "artist-local",
        primaryArtistName: "Local Artist",
        albumId: "album-local",
        albumName: "Local Album",
        addedAt: null,
        durationMs: 180_000,
        isLiked,
        availability: LikedTrackAvailability.AVAILABLE,
      },
    ],
    evidence: [
      {
        id: "evidence-local",
        spotifyTrackId: "track-local",
        spotifyArtistId: "artist-local",
        artistName: "Local Artist",
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
    ],
    affinityStates: [
      {
        id: "affinity-local",
        spotifyArtistId: "artist-local",
        artistName: "Local Artist",
        likedTrackCount: 1,
        active: true,
      },
    ],
    localExplicitTrackIds: ["track-local"],
  };
}

test("provider absence does not unlike a Sonoriza explicit LIKE or erase its affinity", () => {
  const plan = buildLikedTrackAffinityPlan(
    emptyProvider(),
    existing(true),
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    NOW,
  );

  assert.equal(plan.providerCanonicalTrackCount, 0);
  assert.deepEqual(plan.currentTracks.map((track) => track.spotifyTrackId), [
    "track-local",
  ]);
  assert.deepEqual(plan.tracksToUnlike, []);
  assert.deepEqual(plan.evidenceToDeactivate, []);
  assert.deepEqual(plan.affinityStatesToUpdate, []);
  assert.deepEqual(plan.after, {
    likedTracks: 1,
    activeEvidence: 1,
    activeArtists: 1,
  });
});

test("a durable local explicit action reactivates a previously deactivated canonical row", () => {
  const state = existing(false);
  state.evidence[0]!.active = false;
  state.affinityStates[0]!.likedTrackCount = 0;
  state.affinityStates[0]!.active = false;

  const plan = buildLikedTrackAffinityPlan(
    emptyProvider(),
    state,
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    NOW,
  );

  assert.deepEqual(plan.tracksToReactivate, ["track-local"]);
  assert.deepEqual(plan.evidenceToReactivate.map((row) => row.id), [
    "evidence-local",
  ]);
  assert.deepEqual(plan.affinityStatesToUpdate, [
    {
      spotifyArtistId: "artist-local",
      artistName: "Local Artist",
      likedTrackCount: 1,
      active: true,
    },
  ]);
});
