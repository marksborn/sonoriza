import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtistAffinityEvidenceType,
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import { buildLikedTrackAffinityPlan } from "./liked-track-affinity";
import {
  buildLikedTrackIncrementalBoundary,
  buildSyntheticLikedTrackInventory,
  readSpotifyLikedTrackIncremental,
  type LikedTrackIncrementalProviderRead,
} from "./liked-track-incremental-sync";
import type {
  ExistingLikedTrack,
  ExistingLikedTrackAffinityState,
} from "./liked-track-affinity";
import type { LikedTrackInventoryItem } from "./liked-track-inventory";

const API = "https://api.spotify.com/v1";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("Gate 4B derives the boundary from canonical addedAt, including unliked rows at the newest timestamp", () => {
  const tracks = [
    existingTrack("old", "2026-08-20T10:00:00.000Z", true),
    existingTrack("boundary-a", "2026-08-25T11:17:30.000Z", true),
    existingTrack("boundary-b", "2026-08-25T11:17:30.000Z", false),
  ];

  assert.deepEqual(buildLikedTrackIncrementalBoundary(tracks), {
    watermarkAddedAt: "2026-08-25T11:17:30.000Z",
    boundaryTrackIds: ["boundary-a", "boundary-b"],
  });
});

test("Gate 4B reads only the Saved Tracks prefix and handles same-timestamp boundary ids", async () => {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return jsonResponse({
      items: [
        spotifySavedRow("new-track", "2026-08-27T20:00:00.000Z", 201_000),
        spotifySavedRow("same-time-new", "2026-08-25T11:17:30.000Z", 202_000),
        spotifySavedRow("boundary-a", "2026-08-25T11:17:30.000Z", 203_000),
        spotifySavedRow("older-track", "2026-08-24T10:00:00.000Z", 204_000),
      ],
      next: `${API}/me/tracks?market=from_token&limit=50&offset=50`,
    });
  }) as typeof fetch;

  const result = await readSpotifyLikedTrackIncremental(
    "test-token",
    {
      watermarkAddedAt: "2026-08-25T11:17:30.000Z",
      boundaryTrackIds: ["boundary-a"],
    },
    fetchImpl,
  );

  assert.equal(result.pagesRead, 1);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.stoppedAtOlderItem, true);
  assert.equal(requested.length, 1);
  assert.deepEqual(
    result.newItems.map((item) => item.spotifyTrackId),
    ["new-track", "same-time-new"],
  );
  assert.deepEqual(
    result.items.map((item) => item.spotifyTrackId),
    ["new-track", "same-time-new", "boundary-a"],
  );
});

test("Gate 4B synthetic snapshot preserves every active local like and cannot invent an unlike", () => {
  const existing: ExistingLikedTrackAffinityState = {
    tracks: [
      existingTrack("current-track", "2026-08-25T11:17:30.000Z", true),
      existingTrack("previously-unliked", "2026-08-20T10:00:00.000Z", false),
    ],
    evidence: [
      {
        id: "evidence-current",
        spotifyTrackId: "current-track",
        spotifyArtistId: "artist-current-track",
        artistName: "Artist current-track",
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
    ],
    affinityStates: [
      {
        id: "state-current",
        spotifyArtistId: "artist-current-track",
        artistName: "Artist current-track",
        likedTrackCount: 1,
        active: true,
      },
    ],
  };
  const provider: LikedTrackIncrementalProviderRead = {
    items: [inventoryItem("new-track", "2026-08-27T20:00:00.000Z", 222_000)],
    newItems: [inventoryItem("new-track", "2026-08-27T20:00:00.000Z", 222_000)],
    pagesRead: 1,
    providerCalls: 1,
    retries: 0,
    rateLimitedCount: 0,
    retryWaitMs: 0,
    stoppedAtOlderItem: true,
  };

  const synthetic = buildSyntheticLikedTrackInventory(existing, provider);
  assert.deepEqual(
    synthetic.items.flatMap((item) => item.spotifyTrackId ? [item.spotifyTrackId] : []).sort(),
    ["current-track", "new-track"],
  );

  const plan = buildLikedTrackAffinityPlan(
    synthetic,
    existing,
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    new Date("2026-08-27T20:01:00.000Z"),
  );

  assert.deepEqual(plan.tracksToUnlike, []);
  assert.equal(plan.tracksToCreate.length, 1);
  assert.equal(plan.tracksToCreate[0]?.spotifyTrackId, "new-track");
  assert.equal(plan.tracksToCreate[0]?.durationMs, 222_000);
  assert.equal(plan.evidenceToCreate.length, 1);
  assert.equal(plan.evidenceToCreate[0]?.spotifyArtistId, "artist-new-track");
  assert.equal(plan.affinityStatesToCreate.length, 1);
  assert.equal(plan.affinityStatesToCreate[0]?.likedTrackCount, 1);
});

function existingTrack(
  spotifyTrackId: string,
  addedAt: string,
  isLiked: boolean,
): ExistingLikedTrack {
  return {
    id: `liked-${spotifyTrackId}`,
    spotifyTrackId,
    spotifyUri: `spotify:track:${spotifyTrackId}`,
    trackName: `Track ${spotifyTrackId}`,
    primaryArtistId: `artist-${spotifyTrackId}`,
    primaryArtistName: `Artist ${spotifyTrackId}`,
    albumId: `album-${spotifyTrackId}`,
    albumName: `Album ${spotifyTrackId}`,
    addedAt: new Date(addedAt),
    durationMs: 180_000,
    isLiked,
    availability: LikedTrackAvailability.AVAILABLE,
  };
}

function inventoryItem(
  spotifyTrackId: string,
  addedAt: string,
  durationMs: number,
): LikedTrackInventoryItem {
  return {
    addedAt,
    spotifyTrackId,
    effectiveSpotifyTrackId: spotifyTrackId,
    uri: `spotify:track:${spotifyTrackId}`,
    title: `Track ${spotifyTrackId}`,
    primaryArtistId: `artist-${spotifyTrackId}`,
    primaryArtistName: `Artist ${spotifyTrackId}`,
    albumId: `album-${spotifyTrackId}`,
    albumName: `Album ${spotifyTrackId}`,
    durationMs,
    status: "AVAILABLE",
    restrictionReason: null,
  };
}

function spotifySavedRow(
  spotifyTrackId: string,
  addedAt: string,
  durationMs: number,
) {
  return {
    added_at: addedAt,
    track: {
      id: spotifyTrackId,
      uri: `spotify:track:${spotifyTrackId}`,
      name: `Track ${spotifyTrackId}`,
      duration_ms: durationMs,
      type: "track",
      is_playable: true,
      artists: [
        {
          id: `artist-${spotifyTrackId}`,
          name: `Artist ${spotifyTrackId}`,
        },
      ],
      album: {
        id: `album-${spotifyTrackId}`,
        name: `Album ${spotifyTrackId}`,
      },
    },
  };
}
