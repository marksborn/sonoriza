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
} from "@/services/music-preference/liked-track-affinity";
import type {
  LikedTrackInventoryItem,
  SpotifyLikedTrackInventory,
} from "@/services/music-preference/liked-track-inventory";

const NOW = new Date("2026-08-25T18:00:00.000Z");
const PROVENANCE = LikedTrackPreferenceProvenance.LIKED_TRACK_BACKFILL;

function item(
  spotifyTrackId: string,
  spotifyArtistId: string | null,
  options: Partial<LikedTrackInventoryItem> = {},
): LikedTrackInventoryItem {
  return {
    addedAt: "2026-08-20T10:00:00.000Z",
    spotifyTrackId,
    effectiveSpotifyTrackId: spotifyTrackId,
    uri: `spotify:track:${spotifyTrackId}`,
    title: `Track ${spotifyTrackId}`,
    primaryArtistId: spotifyArtistId,
    primaryArtistName: spotifyArtistId ? `Artist ${spotifyArtistId}` : null,
    albumId: `album-${spotifyTrackId}`,
    albumName: `Album ${spotifyTrackId}`,
    durationMs: 180_000,
    status: "AVAILABLE",
    restrictionReason: null,
    ...options,
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

function emptyExisting(): ExistingLikedTrackAffinityState {
  return { tracks: [], evidence: [], affinityStates: [] };
}

test("deduplicates canonical liked tracks and does not multiply artist affinity", () => {
  const plan = buildLikedTrackAffinityPlan(
    provider([item("track-1", "artist-a"), item("track-2", "artist-a"), item("track-1", "artist-a")]),
    emptyExisting(),
    PROVENANCE,
    NOW,
  );

  assert.equal(plan.technicalDuplicateRows, 1);
  assert.equal(plan.currentTracks.length, 2);
  assert.equal(plan.tracksToCreate.length, 2);
  assert.equal(plan.evidenceToCreate.length, 2);
  assert.equal(plan.affinityStatesToCreate.length, 1);
  assert.deepEqual(plan.affinityStatesToCreate[0], {
    spotifyArtistId: "artist-a",
    artistName: "Artist artist-a",
    likedTrackCount: 2,
    active: true,
  });
  assert.deepEqual(plan.after, {
    likedTracks: 2,
    activeEvidence: 2,
    activeArtists: 1,
  });
});

test("same provider snapshot is semantically idempotent", () => {
  const existing: ExistingLikedTrackAffinityState = {
    tracks: [
      {
        id: "liked-1",
        spotifyTrackId: "track-1",
        spotifyUri: "spotify:track:track-1",
        trackName: "Track track-1",
        primaryArtistId: "artist-a",
        primaryArtistName: "Artist artist-a",
        albumId: "album-track-1",
        albumName: "Album track-1",
        addedAt: new Date("2026-08-20T10:00:00.000Z"),
        isLiked: true,
        availability: LikedTrackAvailability.AVAILABLE,
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        spotifyTrackId: "track-1",
        spotifyArtistId: "artist-a",
        artistName: "Artist artist-a",
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
    ],
    affinityStates: [
      {
        id: "affinity-1",
        spotifyArtistId: "artist-a",
        artistName: "Artist artist-a",
        likedTrackCount: 1,
        active: true,
      },
    ],
  };

  const plan = buildLikedTrackAffinityPlan(
    provider([item("track-1", "artist-a")]),
    existing,
    PROVENANCE,
    NOW,
  );

  assert.equal(plan.tracksToCreate.length, 0);
  assert.equal(plan.tracksToReactivate.length, 0);
  assert.equal(plan.tracksToUnlike.length, 0);
  assert.equal(plan.trackMetadataUpdates.length, 0);
  assert.equal(plan.evidenceToCreate.length, 0);
  assert.equal(plan.evidenceToReactivate.length, 0);
  assert.equal(plan.evidenceToDeactivate.length, 0);
  assert.equal(plan.evidenceMetadataUpdates.length, 0);
  assert.equal(plan.affinityStatesToCreate.length, 0);
  assert.equal(plan.affinityStatesToUpdate.length, 0);
});

test("unlike removes only that track evidence and preserves artist affinity from another like", () => {
  const existing: ExistingLikedTrackAffinityState = {
    tracks: [
      {
        id: "liked-1",
        spotifyTrackId: "track-1",
        spotifyUri: "spotify:track:track-1",
        trackName: "Track track-1",
        primaryArtistId: "artist-a",
        primaryArtistName: "Artist artist-a",
        albumId: "album-track-1",
        albumName: "Album track-1",
        addedAt: new Date("2026-08-20T10:00:00.000Z"),
        isLiked: true,
        availability: LikedTrackAvailability.AVAILABLE,
      },
      {
        id: "liked-2",
        spotifyTrackId: "track-2",
        spotifyUri: "spotify:track:track-2",
        trackName: "Track track-2",
        primaryArtistId: "artist-a",
        primaryArtistName: "Artist artist-a",
        albumId: "album-track-2",
        albumName: "Album track-2",
        addedAt: new Date("2026-08-20T10:00:00.000Z"),
        isLiked: true,
        availability: LikedTrackAvailability.AVAILABLE,
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        spotifyTrackId: "track-1",
        spotifyArtistId: "artist-a",
        artistName: "Artist artist-a",
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
      {
        id: "evidence-2",
        spotifyTrackId: "track-2",
        spotifyArtistId: "artist-a",
        artistName: "Artist artist-a",
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
    ],
    affinityStates: [
      {
        id: "affinity-1",
        spotifyArtistId: "artist-a",
        artistName: "Artist artist-a",
        likedTrackCount: 2,
        active: true,
      },
    ],
  };

  const plan = buildLikedTrackAffinityPlan(
    provider([item("track-2", "artist-a")]),
    existing,
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    NOW,
  );

  assert.deepEqual(plan.tracksToUnlike, ["track-1"]);
  assert.deepEqual(plan.evidenceToDeactivate.map((row) => row.id), ["evidence-1"]);
  assert.equal(plan.affinityStatesToUpdate.length, 1);
  assert.deepEqual(plan.affinityStatesToUpdate[0], {
    spotifyArtistId: "artist-a",
    artistName: "Artist artist-a",
    likedTrackCount: 1,
    active: true,
  });
  assert.equal(plan.after.activeArtists, 1);
});

test("removing the last liked track leaves an auditable inactive artist state", () => {
  const existing: ExistingLikedTrackAffinityState = {
    tracks: [
      {
        id: "liked-1",
        spotifyTrackId: "track-1",
        spotifyUri: "spotify:track:track-1",
        trackName: "Track track-1",
        primaryArtistId: "artist-a",
        primaryArtistName: "Artist artist-a",
        albumId: "album-track-1",
        albumName: "Album track-1",
        addedAt: new Date("2026-08-20T10:00:00.000Z"),
        isLiked: true,
        availability: LikedTrackAvailability.AVAILABLE,
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        spotifyTrackId: "track-1",
        spotifyArtistId: "artist-a",
        artistName: "Artist artist-a",
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
    ],
    affinityStates: [
      {
        id: "affinity-1",
        spotifyArtistId: "artist-a",
        artistName: "Artist artist-a",
        likedTrackCount: 1,
        active: true,
      },
    ],
  };

  const plan = buildLikedTrackAffinityPlan(
    provider([]),
    existing,
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    NOW,
  );

  assert.deepEqual(plan.tracksToUnlike, ["track-1"]);
  assert.equal(plan.evidenceToDeactivate.length, 1);
  assert.deepEqual(plan.affinityStatesToUpdate[0], {
    spotifyArtistId: "artist-a",
    artistName: "Artist artist-a",
    likedTrackCount: 0,
    active: false,
  });
  assert.deepEqual(plan.after, {
    likedTracks: 0,
    activeEvidence: 0,
    activeArtists: 0,
  });
});

test("canonical liked track without resolved primary artist is kept without inventing affinity", () => {
  const plan = buildLikedTrackAffinityPlan(
    provider([item("track-1", null)]),
    emptyExisting(),
    PROVENANCE,
    NOW,
  );

  assert.equal(plan.tracksToCreate.length, 1);
  assert.equal(plan.tracksWithoutResolvedPrimaryArtist, 1);
  assert.equal(plan.evidenceToCreate.length, 0);
  assert.equal(plan.affinityStatesToCreate.length, 0);
  assert.equal(plan.after.likedTracks, 1);
  assert.equal(plan.after.activeArtists, 0);
});

test("unavailable canonical track remains a positive like and can sustain artist affinity", () => {
  const plan = buildLikedTrackAffinityPlan(
    provider([
      item("track-1", "artist-a", {
        status: "UNAVAILABLE",
        uri: null,
        restrictionReason: "market",
      }),
    ]),
    emptyExisting(),
    PROVENANCE,
    NOW,
  );

  assert.equal(plan.tracksToCreate[0]?.availability, LikedTrackAvailability.UNAVAILABLE);
  assert.equal(plan.evidenceToCreate.length, 1);
  assert.equal(plan.after.activeArtists, 1);
});
