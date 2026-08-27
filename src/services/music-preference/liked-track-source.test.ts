import assert from "node:assert/strict";
import test from "node:test";

import { LikedTrackAvailability } from "@prisma/client";

import {
  buildLikedTrackSourceSnapshot,
  LIKED_TRACKS_NATIVE_SOURCE_KEY,
  LIKED_TRACKS_NATIVE_SOURCE_TYPE,
  type LikedTrackSourceRow,
} from "./liked-track-source";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function row(
  overrides: Partial<LikedTrackSourceRow> & Pick<LikedTrackSourceRow, "spotifyTrackId">,
): LikedTrackSourceRow {
  return {
    spotifyTrackId: overrides.spotifyTrackId,
    spotifyUri: overrides.spotifyUri ?? `spotify:track:${overrides.spotifyTrackId}`,
    trackName: overrides.trackName ?? "Track",
    primaryArtistId: overrides.primaryArtistId ?? "artist-1",
    primaryArtistName: overrides.primaryArtistName ?? "Artist",
    albumId: overrides.albumId ?? "album-1",
    albumName: overrides.albumName ?? "Album",
    addedAt: overrides.addedAt ?? new Date("2026-08-20T00:00:00.000Z"),
    availability: overrides.availability ?? LikedTrackAvailability.AVAILABLE,
    lastObservedAt: overrides.lastObservedAt ?? NOW,
  };
}

test("buildLikedTrackSourceSnapshot exposes a local persistent native source", () => {
  const snapshot = buildLikedTrackSourceSnapshot(
    [
      row({ spotifyTrackId: "a" }),
      row({
        spotifyTrackId: "b",
        availability: LikedTrackAvailability.UNAVAILABLE,
        spotifyUri: null,
      }),
      row({
        spotifyTrackId: "c",
        availability: LikedTrackAvailability.INVALID,
        trackName: null,
        primaryArtistId: null,
        primaryArtistName: null,
        albumId: null,
        albumName: null,
      }),
    ],
    NOW,
  );

  assert.equal(snapshot.source.key, LIKED_TRACKS_NATIVE_SOURCE_KEY);
  assert.equal(snapshot.source.type, LIKED_TRACKS_NATIVE_SOURCE_TYPE);
  assert.equal(snapshot.source.kind, "MUSIC");
  assert.equal(snapshot.source.semantics, "PERSISTENT_LIBRARY");
  assert.equal(snapshot.source.providerReads, false);
  assert.equal(snapshot.source.spotifyWrites, false);
  assert.equal(snapshot.source.plannerInfluence, false);

  assert.deepEqual(snapshot.counts, {
    activeLikedTracks: 3,
    available: 1,
    unavailable: 1,
    invalid: 1,
    withUri: 2,
    withTitle: 2,
    withPrimaryArtist: 2,
    withAlbum: 2,
    locallyMaterializedIdentity: 1,
  });

  assert.equal(snapshot.plannerMaterialization.ready, false);
  assert.equal(snapshot.plannerMaterialization.blocker, "DURATION_NOT_PERSISTED");
  assert.equal(snapshot.plannerMaterialization.requiredMissingField, "durationMs");
});

test("buildLikedTrackSourceSnapshot keeps freshness and sample deterministic", () => {
  const snapshot = buildLikedTrackSourceSnapshot(
    [
      row({
        spotifyTrackId: "newer",
        trackName: "Newer",
        addedAt: new Date("2026-08-25T00:00:00.000Z"),
        lastObservedAt: new Date("2026-08-27T11:00:00.000Z"),
      }),
      row({
        spotifyTrackId: "older",
        trackName: "Older",
        addedAt: new Date("2020-01-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-08-26T11:00:00.000Z"),
      }),
    ],
    NOW,
  );

  assert.equal(snapshot.freshness.newestAddedAt?.toISOString(), "2026-08-25T00:00:00.000Z");
  assert.equal(snapshot.freshness.oldestAddedAt?.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(snapshot.freshness.latestObservedAt?.toISOString(), "2026-08-27T11:00:00.000Z");
  assert.deepEqual(
    snapshot.sample.map((item) => item.spotifyTrackId),
    ["newer", "older"],
  );
});
