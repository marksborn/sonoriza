import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createPlaylistRuleState,
  createSavedRuleState,
  parseIngestionRuleState,
  parseSpotifyReference,
  planMusicIngestion,
  playlistNewOccurrences,
  savedTrackNewEvents,
  sortAlbumTracks,
  type IngestionCandidate,
  type MusicIngestionTrack,
  type SavedTrackEvent,
} from "./music-ingestion-core";

function track(id: string, extra: Partial<MusicIngestionTrack> = {}): MusicIngestionTrack {
  return {
    spotifyTrackId: id,
    uri: `spotify:track:${id}`,
    title: `Track ${id}`,
    durationMs: 180_000,
    ...extra,
  };
}

function candidate(id: string): IngestionCandidate {
  return { track: track(id), origin: { kind: "PLAYLIST_COPY", sourceSpotifyId: "source" } };
}

test("PLAYLIST_COPY adds only new occurrence counts", () => {
  const previous = createPlaylistRuleState("snap-1", [track("A"), track("A"), track("B")]);
  const current = [track("A"), track("A"), track("A"), track("B"), track("C")];
  assert.deepEqual(
    playlistNewOccurrences(previous, current).map((item) => item.spotifyTrackId),
    ["A", "C"],
  );
});

test("PLAYLIST_COPY removal followed by later re-add becomes a new event", () => {
  const initial = createPlaylistRuleState("snap-1", [track("A")]);
  const removed = createPlaylistRuleState("snap-2", []);
  assert.deepEqual(playlistNewOccurrences(initial, []), []);
  assert.deepEqual(
    playlistNewOccurrences(removed, [track("A")]).map((item) => item.spotifyTrackId),
    ["A"],
  );
});

test("same source occurrence cannot resurrect merely because target inbox removed it", () => {
  const previous = createPlaylistRuleState("snap-1", [track("A")]);
  assert.deepEqual(playlistNewOccurrences(previous, [track("A")]), []);
});

test("saved track watermark is incremental and equal-time boundary is idempotent", () => {
  const base: SavedTrackEvent[] = [
    { addedAt: "2026-08-09T10:00:00.000Z", track: track("A") },
    { addedAt: "2026-08-09T10:00:00.000Z", track: track("B") },
  ];
  const state = createSavedRuleState("SAVED_TRACK", base);
  assert.deepEqual(savedTrackNewEvents(state, base), []);

  const next = [
    { addedAt: "2026-08-09T11:00:00.000Z", track: track("C") },
    { addedAt: "2026-08-09T10:00:00.000Z", track: track("D") },
    ...base,
  ];
  assert.deepEqual(
    savedTrackNewEvents(state, next).map((event) => event.track.spotifyTrackId),
    ["C", "D"],
  );
});

test("a later real saved-track event can reintroduce the same identity", () => {
  const state = createSavedRuleState("SAVED_TRACK", [
    { addedAt: "2026-01-01T00:00:00.000Z", track: track("A") },
  ]);
  const events = savedTrackNewEvents(state, [
    { addedAt: "2026-08-09T00:00:00.000Z", track: track("A") },
  ]);
  assert.equal(events.length, 1);
});

test("dedupe keeps one physical target occurrence across multiple sources", () => {
  const plan = planMusicIngestion(
    [candidate("A"), { ...candidate("A"), origin: { kind: "SAVED_TRACK", eventTrackId: "A" } }],
    new Set(),
    new Set(),
  );
  assert.deepEqual(plan.add.map((item) => item.track.spotifyTrackId), ["A"]);
  assert.equal(plan.duplicate.length, 1);
});

test("existing inbox item is not duplicated", () => {
  const plan = planMusicIngestion([candidate("A"), candidate("B")], new Set(["A"]), new Set());
  assert.deepEqual(plan.add.map((item) => item.track.spotifyTrackId), ["B"]);
  assert.deepEqual(plan.duplicate.map((item) => item.track.spotifyTrackId), ["A"]);
});

test("MUSIC-01 cooldown wins before target insertion", () => {
  const plan = planMusicIngestion([candidate("A"), candidate("B")], new Set(), new Set(["A"]));
  assert.deepEqual(plan.add.map((item) => item.track.spotifyTrackId), ["B"]);
  assert.deepEqual(plan.cooldown.map((item) => item.track.spotifyTrackId), ["A"]);
});

test("album expansion order is deterministic by disc and track", () => {
  const sorted = sortAlbumTracks([
    track("C", { discNumber: 2, trackNumber: 1 }),
    track("B", { discNumber: 1, trackNumber: 2 }),
    track("A", { discNumber: 1, trackNumber: 1 }),
  ]);
  assert.deepEqual(sorted.map((item) => item.spotifyTrackId), ["A", "B", "C"]);
});

test("Spotify URI and URL references parse without accepting unrelated URLs", () => {
  assert.deepEqual(parseSpotifyReference("spotify:track:abc123"), { type: "track", id: "abc123" });
  assert.deepEqual(parseSpotifyReference("https://open.spotify.com/album/xyz789"), {
    type: "album",
    id: "xyz789",
  });
  assert.equal(parseSpotifyReference("https://example.com/track/abc123"), null);
});

test("persisted ingestion state decoder rejects malformed payloads", () => {
  assert.equal(parseIngestionRuleState({ version: 1, initialized: true, kind: "PLAYLIST_COPY" }), null);
  assert.deepEqual(
    parseIngestionRuleState({
      version: 1,
      initialized: true,
      kind: "SAVED_TRACK_ALBUM",
      watermarkAddedAt: null,
      boundaryTrackIds: [],
    }),
    {
      version: 1,
      initialized: true,
      kind: "SAVED_TRACK_ALBUM",
      watermarkAddedAt: null,
      boundaryTrackIds: [],
    },
  );
});


test("MUSIC-03 managed writes preserve SPOTIFY-01 cache continuity", () => {
  const source = readFileSync("src/services/spotify/music-ingestion.ts", "utf8");
  assert.match(source, /snapshot_id\?: string \| null/);
  assert.match(source, /maintainTargetCacheAfterAppend/);
  assert.match(source, /patchMusicSourceCacheAfterAppend/);
  assert.match(source, /spotifySnapshotId: nextSnapshotId/);
});


test("MUSIC-03 refreshed DB cache is carried into managed append patches", () => {
  const source = readFileSync("src/services/spotify/music-ingestion.ts", "utf8");
  assert.match(source, /const refreshed = await prisma\.sourcePlaylist\.findUnique/);
  assert.match(source, /cacheValue: refreshed\.cachedCandidates/);
  assert.match(source, /targetIndex\.cacheValue/);
});
