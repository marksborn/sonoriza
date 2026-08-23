import assert from "node:assert/strict";
import test from "node:test";

import type {
  SpotifyAlbumCatalogSummary,
  SpotifyAlbumCatalogTrack,
} from "@/services/spotify/album-catalog";

import {
  buildAlbumCoverageFacts,
  selectDiagnosticAlbumSample,
  type AlbumHistoryEvent,
} from "./profile";

const AS_OF = new Date("2026-08-23T12:00:00.000Z");
const ARTIST_ID = "artist-1";
const ARTIST = "Artist One";

function album(id = "album-a", name = "Album A", releaseDate = "2020-01-01"): SpotifyAlbumCatalogSummary {
  return {
    id,
    name,
    uri: `spotify:album:${id}`,
    spotifyUrl: null,
    albumType: "album",
    albumGroup: "album",
    totalTracks: 4,
    releaseDate,
    artists: [{ id: ARTIST_ID, name: ARTIST }],
  };
}

function track(id: string, name: string, trackNumber: number): SpotifyAlbumCatalogTrack {
  return {
    id,
    name,
    uri: `spotify:track:${id}`,
    durationMs: 200_000,
    discNumber: 1,
    trackNumber,
    isPlayable: true,
    artists: [{ id: ARTIST_ID, name: ARTIST }],
  };
}

function event(overrides: Partial<AlbumHistoryEvent>): AlbumHistoryEvent {
  return {
    spotifyTrackId: null,
    trackName: "Track 1",
    artistName: ARTIST,
    primaryArtistId: null,
    albumName: "Album A",
    albumId: null,
    playedAt: new Date("2026-08-20T12:00:00.000Z"),
    source: "LASTFM_SCROBBLE",
    metadata: null,
    ...overrides,
  };
}

const TRACKS = [
  track("track-1", "Track 1", 1),
  track("track-2", "Track 2", 2),
  track("track-3", "Track 3", 3),
  track("track-4", "Track 4", 4),
];

test("keeps canonical and label-only album coverage separate and explainable", () => {
  const facts = buildAlbumCoverageFacts({
    album: album(),
    tracks: TRACKS,
    spotifyArtistId: ARTIST_ID,
    spotifyArtistName: ARTIST,
    asOf: AS_OF,
    events: [
      event({
        spotifyTrackId: "track-1",
        primaryArtistId: ARTIST_ID,
        albumId: "album-a",
      }),
      event({
        spotifyTrackId: "relinked-track-2",
        trackName: "Track 2",
        primaryArtistId: ARTIST_ID,
        albumId: "album-a",
        metadata: { spotifyExtendedHistory: { explicitSkip: true } },
      }),
      event({ trackName: "Track 3" }),
      event({
        spotifyTrackId: "other-edition-track-4",
        trackName: "Track 4",
        primaryArtistId: ARTIST_ID,
        albumId: "album-b",
      }),
    ],
  });

  assert.equal(facts.canonicalObservedTrackCount, 2);
  assert.equal(facts.labelOnlyObservedTrackCount, 1);
  assert.equal(facts.observedTrackCount, 3);
  assert.equal(facts.canonicalCoverage, 0.5);
  assert.equal(facts.analyticCoverage, 0.75);
  assert.equal(facts.confidence, "MIXED_CANONICAL_AND_LABEL");
  assert.equal(facts.matchedEventCount, 3);
  assert.equal(facts.explicitSkipEventCount, 1);
  assert.equal(facts.plays30d, 3);
});

test("does not merge a different Spotify album edition by equal artist album and track labels", () => {
  const facts = buildAlbumCoverageFacts({
    album: album("album-a", "Same Name"),
    tracks: [track("edition-a-track", "Shared Song", 1)],
    spotifyArtistId: ARTIST_ID,
    spotifyArtistName: ARTIST,
    asOf: AS_OF,
    events: [
      event({
        spotifyTrackId: "edition-b-track",
        trackName: "Shared Song",
        primaryArtistId: ARTIST_ID,
        albumName: "Same Name",
        albumId: "album-b",
      }),
    ],
  });

  assert.equal(facts.observedTrackCount, 0);
  assert.equal(facts.confidence, "NO_HISTORY");
});

test("id-less historical labels can support analytics without becoming canonical identity", () => {
  const facts = buildAlbumCoverageFacts({
    album: album(),
    tracks: TRACKS,
    spotifyArtistId: ARTIST_ID,
    spotifyArtistName: ARTIST,
    asOf: AS_OF,
    events: [event({ trackName: "Track 1" }), event({ trackName: "Track 2" })],
  });

  assert.equal(facts.canonicalObservedTrackCount, 0);
  assert.equal(facts.labelOnlyObservedTrackCount, 2);
  assert.equal(facts.analyticCoverage, 0.5);
  assert.equal(facts.confidence, "LABEL_ONLY");
});

test("a conflicting primary artist id blocks text fallback", () => {
  const facts = buildAlbumCoverageFacts({
    album: album(),
    tracks: TRACKS,
    spotifyArtistId: ARTIST_ID,
    spotifyArtistName: ARTIST,
    asOf: AS_OF,
    events: [
      event({
        trackName: "Track 1",
        primaryArtistId: "different-artist",
      }),
    ],
  });
  assert.equal(facts.observedTrackCount, 0);
});

test("diagnostic sampling includes both historically represented and unseen albums", () => {
  const albums = Array.from({ length: 8 }, (_, index) =>
    album(
      `album-${index + 1}`,
      `Album ${index + 1}`,
      `${2026 - index}-01-01`,
    ),
  );
  const selected = selectDiagnosticAlbumSample({
    albums,
    maxAlbums: 4,
    events: [
      event({ albumId: "album-7", albumName: "Album 7" }),
      event({ albumId: "album-8", albumName: "Album 8" }),
    ],
  });

  assert.equal(selected.length, 4);
  const ids = new Set(selected.map((row) => row.id));
  assert.equal(ids.has("album-7"), true);
  assert.equal(ids.has("album-8"), true);
  assert.equal([...ids].some((id) => id !== "album-7" && id !== "album-8"), true);
});
