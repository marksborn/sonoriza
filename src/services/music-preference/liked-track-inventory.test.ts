import assert from "node:assert/strict";
import test from "node:test";

import type { DiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";

import {
  buildLikedTrackInventoryReport,
  readSpotifyLikedTrackInventory,
  type SpotifyLikedTrackInventory,
} from "./liked-track-inventory";

const API = "https://api.spotify.com/v1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Saved Tracks inventory paginates, keeps relinked identity and classifies unavailable/invalid rows", async () => {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);

    if (requested.length === 1) {
      return jsonResponse({
        items: [
          {
            added_at: "2026-08-25T10:00:00Z",
            track: {
              id: "effective-a",
              linked_from: { id: "canonical-a" },
              uri: "spotify:track:effective-a",
              name: "Track A",
              duration_ms: 180_000,
              type: "track",
              is_playable: true,
              artists: [{ id: "artist-a", name: "Artist A" }],
              album: { id: "album-a", name: "Album A" },
            },
          },
          {
            added_at: "2026-08-24T10:00:00Z",
            track: {
              id: "track-b",
              uri: "spotify:track:track-b",
              name: "Track B",
              duration_ms: 200_000,
              type: "track",
              is_playable: false,
              restrictions: { reason: "market" },
              artists: [{ id: "artist-b", name: "Artist B" }],
              album: { id: "album-b", name: "Album B" },
            },
          },
          { added_at: "2026-08-23T10:00:00Z", track: null },
        ],
        next: `${API}/me/tracks?market=from_token&limit=50&offset=50`,
      });
    }

    return jsonResponse({
      items: [
        {
          added_at: "2026-08-22T10:00:00Z",
          track: {
            id: "track-c",
            uri: "spotify:track:track-c",
            name: "Track C",
            duration_ms: 210_000,
            type: "track",
            is_playable: true,
            artists: [{ name: "Artist Without Id" }],
            album: { id: "album-c", name: "Album C" },
          },
        },
      ],
      next: null,
    });
  }) as typeof fetch;

  const inventory = await readSpotifyLikedTrackInventory("test-token", fetchImpl);

  assert.equal(inventory.pagesRead, 2);
  assert.equal(inventory.providerCalls, 2);
  assert.equal(inventory.retries, 0);
  assert.equal(requested[0], `${API}/me/tracks?market=from_token&limit=50`);
  assert.equal(requested[1], `${API}/me/tracks?market=from_token&limit=50&offset=50`);
  assert.deepEqual(
    inventory.items.map((item) => ({
      id: item.spotifyTrackId,
      effective: item.effectiveSpotifyTrackId,
      status: item.status,
    })),
    [
      { id: "canonical-a", effective: "effective-a", status: "AVAILABLE" },
      { id: "track-b", effective: "track-b", status: "UNAVAILABLE" },
      { id: null, effective: null, status: "INVALID" },
      { id: "track-c", effective: "track-c", status: "AVAILABLE" },
    ],
  );
  assert.equal(inventory.items[1]?.restrictionReason, "market");
});

test("Gate 1 report compares liked tracks with canonical local history without mutating state", () => {
  const provider: SpotifyLikedTrackInventory = {
    items: [
      item("track-a", "artist-a", "2026-08-25T10:00:00Z"),
      item("track-b", "artist-b", "2026-08-24T10:00:00Z"),
      item("track-b", "artist-b", "2026-08-23T10:00:00Z"),
      item("track-c", null, "2026-08-22T10:00:00Z", "UNAVAILABLE", "Artist C"),
      item(null, null, null, "INVALID"),
    ],
    pagesRead: 3,
    providerCalls: 4,
    retries: 1,
    rateLimitedCount: 1,
    retryWaitMs: 250,
  };
  const localIdentity: DiscoveryTrackIdentityEvidence[] = [
    {
      spotifyTrackId: "track-a",
      isrc: "BRAAA1234567",
      primaryArtistId: "artist-a",
      isrcConflict: false,
      primaryArtistIdConflict: false,
    },
    {
      spotifyTrackId: "history-only",
      isrc: null,
      primaryArtistId: null,
      isrcConflict: false,
      primaryArtistIdConflict: false,
    },
  ];

  const generatedAt = new Date("2026-08-25T13:00:00Z");
  const report = buildLikedTrackInventoryReport(provider, localIdentity, generatedAt);

  assert.equal(report.mode, "READ_ONLY");
  assert.equal(report.generatedAt, generatedAt);
  assert.deepEqual(report.provider, {
    rows: 5,
    availableRows: 3,
    unavailableRows: 1,
    invalidRows: 1,
    rowsWithoutCanonicalTrackId: 1,
    distinctCanonicalTracks: 3,
    duplicateTechnicalRows: 1,
    distinctArtists: 3,
    newestAddedAt: new Date("2026-08-25T10:00:00Z"),
    oldestAddedAt: new Date("2026-08-22T10:00:00Z"),
    pagesRead: 3,
    providerCalls: 4,
    retries: 1,
    rateLimitedCount: 1,
    retryWaitMs: 250,
  });
  assert.deepEqual(report.local, {
    historyCanonicalTracks: 2,
    likedTracksKnownInHistory: 1,
    likedTracksMissingFromHistory: 2,
    likedTracksWithIsrcEvidence: 1,
    likedTracksWithPrimaryArtistIdEvidence: 1,
    likedTracksWithIsrcConflict: 0,
    likedTracksWithPrimaryArtistIdConflict: 0,
  });
  assert.deepEqual(report.synchronization, {
    pageSize: 50,
    existingAdditionStrategy: "MUSIC_03_SAVED_TRACK_WATERMARK",
    additionsCanBeIncremental: true,
    removalsRequireReconciliation: true,
    fullScanProviderCalls: 4,
  });
});

function item(
  spotifyTrackId: string | null,
  primaryArtistId: string | null,
  addedAt: string | null,
  status: "AVAILABLE" | "UNAVAILABLE" | "INVALID" = "AVAILABLE",
  primaryArtistName: string | null = primaryArtistId,
) {
  return {
    addedAt,
    spotifyTrackId,
    effectiveSpotifyTrackId: spotifyTrackId,
    uri: spotifyTrackId ? `spotify:track:${spotifyTrackId}` : null,
    title: spotifyTrackId,
    primaryArtistId,
    primaryArtistName,
    albumId: null,
    albumName: null,
    status,
    restrictionReason: status === "UNAVAILABLE" ? "market" : null,
  };
}
