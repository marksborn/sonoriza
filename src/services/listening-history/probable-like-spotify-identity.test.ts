import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyCatalogTrackSummary } from "@/services/spotify/catalog-search";
import {
  probableLikeTrackIdentityKey,
  selectStrongSpotifyTrackMatch,
  type HistoricalSpotifyTrackEvidence,
} from "./probable-like-spotify-identity";

function evidence(
  overrides: Partial<HistoricalSpotifyTrackEvidence> = {},
): HistoricalSpotifyTrackEvidence {
  return {
    historicalSpotifyTrackId: overrides.historicalSpotifyTrackId ?? "old-id",
    trackName: overrides.trackName ?? "Light the Torch",
    artistName: overrides.artistName ?? "Soilwork",
    primaryArtistId:
      "primaryArtistId" in overrides
        ? (overrides.primaryArtistId ?? null)
        : "soilwork-current",
    albumName:
      "albumName" in overrides
        ? (overrides.albumName ?? null)
        : "Figure Number Five",
    isrc: "isrc" in overrides ? (overrides.isrc ?? null) : "SEVAA0300104",
  };
}

function track(
  overrides: Partial<SpotifyCatalogTrackSummary> & { id: string },
): SpotifyCatalogTrackSummary {
  return {
    id: overrides.id,
    name: overrides.name ?? "Light The Torch",
    uri: overrides.uri ?? `spotify:track:${overrides.id}`,
    spotifyUrl:
      overrides.spotifyUrl ?? `https://open.spotify.com/track/${overrides.id}`,
    isrc: "isrc" in overrides ? (overrides.isrc ?? null) : "SEVAA0300104",
    artists:
      overrides.artists ?? [
        {
          id: "soilwork-current",
          name: "Soilwork",
          uri: "spotify:artist:soilwork-current",
          spotifyUrl: "https://open.spotify.com/artist/soilwork-current",
        },
      ],
    albumId: overrides.albumId ?? "figure-number-five-current",
    albumName:
      "albumName" in overrides
        ? (overrides.albumName ?? null)
        : "Figure Number Five",
    durationMs: overrides.durationMs ?? 222_000,
  };
}

test("keeps historical Spotify id when it still resolves as the exact recording", () => {
  const result = selectStrongSpotifyTrackMatch(evidence(), [
    track({ id: "old-id" }),
    track({ id: "other-edition" }),
  ]);

  assert.equal(result?.track.id, "old-id");
  assert.equal(result?.resolution, "HISTORICAL_ID_STILL_CURRENT");
});

test("relinks an obsolete historical id by exact ISRC", () => {
  const result = selectStrongSpotifyTrackMatch(evidence(), [
    track({ id: "current-id", isrc: "SE-VAA-03-00104" }),
  ]);

  assert.equal(result?.track.id, "current-id");
  assert.equal(result?.resolution, "ISRC_MATCH");
});

test("ISRC resolves collaborations even when history stores joined artist names", () => {
  const result = selectStrongSpotifyTrackMatch(
    evidence({
      trackName: "Collaboration Song",
      artistName: "Artist A, Artist B",
      primaryArtistId: "artist-a",
      albumName: "Together",
      isrc: "BRABC2600001",
    }),
    [
      track({
        id: "collaboration-current",
        name: "Collaboration Song",
        albumName: "Together",
        isrc: "BR-ABC-26-00001",
        artists: [
          {
            id: "artist-a",
            name: "Artist A",
            uri: "spotify:artist:artist-a",
            spotifyUrl: null,
          },
          {
            id: "artist-b",
            name: "Artist B",
            uri: "spotify:artist:artist-b",
            spotifyUrl: null,
          },
        ],
      }),
    ],
  );

  assert.equal(result?.track.id, "collaboration-current");
  assert.equal(result?.resolution, "ISRC_MATCH");
});

test("uses exact title artist and album when historical ISRC is unavailable", () => {
  const result = selectStrongSpotifyTrackMatch(evidence({ isrc: null }), [
    track({ id: "wrong-album", albumName: "Compilation" }),
    track({ id: "right-album", albumName: "Figure Number Five" }),
  ]);

  assert.equal(result?.track.id, "right-album");
  assert.equal(result?.resolution, "TRACK_ARTIST_ALBUM_MATCH");
});

test("refuses ambiguous editions instead of silently liking the wrong recording", () => {
  const result = selectStrongSpotifyTrackMatch(
    evidence({ isrc: null, albumName: null, primaryArtistId: null }),
    [
      track({ id: "version-a", isrc: "AAA111" }),
      track({ id: "version-b", isrc: "BBB222" }),
    ],
  );

  assert.equal(result, null);
});

test("identity key tolerates case punctuation and accents but requires track and artist", () => {
  assert.equal(
    probableLikeTrackIdentityKey({
      trackName: "Água — Ao Vivo!",
      artistName: "Banda X",
    }),
    probableLikeTrackIdentityKey({
      trackName: "agua ao vivo",
      artistName: "banda x",
    }),
  );
  assert.equal(probableLikeTrackIdentityKey({ trackName: "A", artistName: null }), null);
});

test("identity key preserves non-Latin titles and artists", () => {
  const japanese = probableLikeTrackIdentityKey({
    trackName: "光の歌",
    artistName: "東京バンド",
  });
  const cyrillic = probableLikeTrackIdentityKey({
    trackName: "Свет",
    artistName: "Группа",
  });

  assert.ok(japanese);
  assert.ok(cyrillic);
  assert.notEqual(japanese, cyrillic);
});
