import assert from "node:assert/strict";
import test from "node:test";

import {
  collectRecentReleases,
  isRecentRelease,
  mergeReleaseRadarSeeds,
} from "./release-radar";

const NOW = new Date("2026-10-30T12:00:00Z");
const ARTIST_A = "0OdUWJ0sBjDrqHygGUXeCF";
const ARTIST_B = "3TVXtAsR1Inumwj472S9r4";
const ARTIST_C = "1Xyo4u8uXC1ZmMpatF05PJ";

test("release window: day, month and year precision", () => {
  assert.equal(isRecentRelease("2026-10-20", "day", NOW, 30), true);
  assert.equal(isRecentRelease("2026-09-20", "day", NOW, 30), false);
  assert.equal(isRecentRelease("2026-10-31", "day", NOW, 30), true, "pre-release tolerance of one day");
  assert.equal(isRecentRelease("2026-11-15", "day", NOW, 30), false, "never far in the future");
  assert.equal(isRecentRelease("2026-10", "month", NOW, 30), true, "current month counts");
  assert.equal(isRecentRelease("2026-08", "month", NOW, 30), false);
  assert.equal(isRecentRelease("2026", "year", NOW, 30), false, "bare year is too coarse");
  assert.equal(isRecentRelease(undefined, "day", NOW, 30), false);
  assert.equal(isRecentRelease("garbage", "day", NOW, 30), false);
});

test("seeds: artists in both sources first, invalid ids dropped, capped", () => {
  const seeds = mergeReleaseRadarSeeds(
    [
      { spotifyArtistId: ARTIST_A, artistName: "A", count: 3 },
      { spotifyArtistId: "not-an-id", artistName: "X", count: 99 },
    ],
    [
      { spotifyArtistId: ARTIST_B, artistName: "B", count: 50 },
      { spotifyArtistId: ARTIST_A, artistName: "A", count: 10 },
    ],
    10,
  );
  assert.deepEqual(seeds.map((seed) => seed.spotifyArtistId), [ARTIST_A, ARTIST_B]);
  assert.deepEqual(seeds[0]!.reasons, ["LIKED_TRACKS", "RECENT_LISTENING"]);
  assert.equal(seeds[0]!.weight, 13);
  assert.equal(mergeReleaseRadarSeeds([], [{ spotifyArtistId: ARTIST_C, artistName: null, count: 1 }], 0).length, 0);
});

test("collect: recent releases only, deduped across artists, newest first, heard tracks flagged", async () => {
  const calls: string[] = [];
  const result = await collectRecentReleases({
    seeds: [
      { spotifyArtistId: ARTIST_A, artistName: "A", reasons: ["LIKED_TRACKS"], weight: 1 },
      { spotifyArtistId: ARTIST_B, artistName: "B", reasons: ["RECENT_LISTENING"], weight: 1 },
      { spotifyArtistId: ARTIST_C, artistName: "C", reasons: ["RECENT_LISTENING"], weight: 1 },
    ],
    heardTrackIds: new Set(["t1"]),
    now: NOW,
    reader: {
      artistReleases: async (artistId) => {
        calls.push(`artist:${artistId}`);
        if (artistId === ARTIST_C) throw new Error("Spotify API GET failed (502)");
        return artistId === ARTIST_A
          ? [
              { id: "feat", name: "Feat", album_type: "single", release_date: "2026-10-25", release_date_precision: "day" },
              { id: "old", name: "Old", album_type: "album", release_date: "2024-01-01", release_date_precision: "day" },
            ]
          : [
              { id: "feat", name: "Feat", album_type: "single", release_date: "2026-10-25", release_date_precision: "day" },
              { id: "new", name: "New", album_type: "album", release_date: "2026-10-28", release_date_precision: "day" },
            ];
      },
      releaseTracks: async (albumId) => {
        calls.push(`album:${albumId}`);
        return albumId === "new"
          ? [
              { id: "t1", uri: "spotify:track:t1", name: "One", duration_ms: 200_000 },
              { id: "t2", uri: "spotify:track:t2", name: "Two", duration_ms: 180_000, is_playable: false },
            ]
          : [{ id: "t3", uri: "spotify:track:t3", name: "Three", duration_ms: 150_000 }];
      },
    },
  });

  assert.deepEqual(result.releases.map((release) => release.albumId), ["new", "feat"]);
  assert.deepEqual(result.releases[0]!.tracks, [
    { spotifyTrackId: "t1", uri: "spotify:track:t1", name: "One", durationMs: 200_000, alreadyHeard: true },
  ]);
  assert.equal(calls.filter((call) => call.startsWith("album:")).length, 2, "old release never fetched");
  assert.equal(result.evidence.failures, 1);
  assert.match(result.evidence.firstFailure ?? "", /502/);
  assert.equal(result.evidence.artistReads, 3);
});
