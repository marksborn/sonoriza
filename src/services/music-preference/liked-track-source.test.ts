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

type RowOverrides = Partial<LikedTrackSourceRow> &
  Pick<LikedTrackSourceRow, "spotifyTrackId">;

function explicitOr<K extends keyof LikedTrackSourceRow>(
  overrides: RowOverrides,
  key: K,
  fallback: LikedTrackSourceRow[K],
): LikedTrackSourceRow[K] {
  return Object.prototype.hasOwnProperty.call(overrides, key)
    ? (overrides[key] as LikedTrackSourceRow[K])
    : fallback;
}

function row(overrides: RowOverrides): LikedTrackSourceRow {
  return {
    spotifyTrackId: overrides.spotifyTrackId,
    spotifyUri: explicitOr(
      overrides,
      "spotifyUri",
      `spotify:track:${overrides.spotifyTrackId}`,
    ),
    trackName: explicitOr(overrides, "trackName", "Track"),
    primaryArtistId: explicitOr(overrides, "primaryArtistId", "artist-1"),
    primaryArtistName: explicitOr(overrides, "primaryArtistName", "Artist"),
    albumId: explicitOr(overrides, "albumId", "album-1"),
    albumName: explicitOr(overrides, "albumName", "Album"),
    durationMs: explicitOr(overrides, "durationMs", 180_000),
    addedAt: explicitOr(
      overrides,
      "addedAt",
      new Date("2026-08-20T00:00:00.000Z"),
    ),
    availability: explicitOr(
      overrides,
      "availability",
      LikedTrackAvailability.AVAILABLE,
    ),
    lastObservedAt: explicitOr(overrides, "lastObservedAt", NOW),
  };
}

test("buildLikedTrackSourceSnapshot exposes a local persistent native source", () => {
  const snapshot = buildLikedTrackSourceSnapshot(
    [
      row({ spotifyTrackId: "a", durationMs: null }),
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
        durationMs: null,
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
    withDuration: 1,
    locallyMaterializedIdentity: 1,
    plannerReadyAvailable: 0,
  });

  assert.equal(snapshot.plannerMaterialization.ready, false);
  assert.equal(snapshot.plannerMaterialization.blocker, "DURATION_INCOMPLETE");
  assert.equal(snapshot.plannerMaterialization.requiredMissingField, "durationMs");
  assert.equal(snapshot.plannerMaterialization.eligibleAvailableTracks, 0);
  assert.equal(snapshot.plannerMaterialization.blockedAvailableTracks, 1);
});

test("buildLikedTrackSourceSnapshot becomes shadow-ready only when available rows have duration", () => {
  const snapshot = buildLikedTrackSourceSnapshot(
    [
      row({ spotifyTrackId: "newer", durationMs: 181_000 }),
      row({ spotifyTrackId: "older", durationMs: 199_000 }),
      row({
        spotifyTrackId: "unavailable",
        availability: LikedTrackAvailability.UNAVAILABLE,
        durationMs: null,
      }),
    ],
    NOW,
  );

  assert.equal(snapshot.counts.available, 2);
  assert.equal(snapshot.counts.withDuration, 2);
  assert.equal(snapshot.counts.plannerReadyAvailable, 2);
  assert.equal(snapshot.plannerMaterialization.ready, true);
  assert.equal(snapshot.plannerMaterialization.blocker, null);
  assert.equal(snapshot.plannerMaterialization.requiredMissingField, null);
  assert.equal(snapshot.plannerMaterialization.blockedAvailableTracks, 0);
});

test("buildLikedTrackSourceSnapshot keeps freshness and sample deterministic", () => {
  const snapshot = buildLikedTrackSourceSnapshot(
    [
      row({
        spotifyTrackId: "newer",
        trackName: "Newer",
        durationMs: 181_000,
        addedAt: new Date("2026-08-25T00:00:00.000Z"),
        lastObservedAt: new Date("2026-08-27T11:00:00.000Z"),
      }),
      row({
        spotifyTrackId: "older",
        trackName: "Older",
        durationMs: 199_000,
        addedAt: new Date("2020-01-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-08-26T11:00:00.000Z"),
      }),
    ],
    NOW,
  );

  assert.equal(
    snapshot.freshness.newestAddedAt?.toISOString(),
    "2026-08-25T00:00:00.000Z",
  );
  assert.equal(
    snapshot.freshness.oldestAddedAt?.toISOString(),
    "2020-01-01T00:00:00.000Z",
  );
  assert.equal(
    snapshot.freshness.latestObservedAt?.toISOString(),
    "2026-08-27T11:00:00.000Z",
  );
  assert.deepEqual(
    snapshot.sample.map((item) => [item.spotifyTrackId, item.durationMs]),
    [
      ["newer", 181_000],
      ["older", 199_000],
    ],
  );
});
