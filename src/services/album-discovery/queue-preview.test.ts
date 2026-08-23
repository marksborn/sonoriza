import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyAlbumCatalogTrack } from "@/services/spotify/album-catalog";
import {
  buildAlbumQueuePreview,
  containsContiguousUriSequence,
  resolveAlbumQueuePlaylist,
} from "./queue-preview";

const playlist = { id: "p1", name: "Adicionar", ownerId: "me" };

test("Gate 3 resolves one exact normalized Adicionar playlist", () => {
  const resolved = resolveAlbumQueuePlaylist(
    [playlist, { id: "p2", name: "Outra", ownerId: "me" }],
    " adicionar ",
  );
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.playlist?.id, "p1");
});

test("Gate 3 refuses duplicate playlist names instead of guessing", () => {
  const resolved = resolveAlbumQueuePlaylist(
    [playlist, { id: "p2", name: "ADICIONAR", ownerId: "other" }],
    "Adicionar",
  );
  assert.equal(resolved.status, "AMBIGUOUS");
  assert.equal(resolved.playlist, null);
  assert.equal(resolved.alternatives.length, 2);
});

test("contiguous edition detection preserves playlist positions including null items", () => {
  assert.equal(
    containsContiguousUriSequence(["spotify:track:a", "spotify:track:b"], ["spotify:track:a", "spotify:track:b"]),
    true,
  );
  assert.equal(
    containsContiguousUriSequence(
      ["spotify:track:a", null, "spotify:track:b"],
      ["spotify:track:a", "spotify:track:b"],
    ),
    false,
  );
});

test("Gate 3 appends the complete edition even when individual tracks overlap elsewhere", () => {
  const preview = buildAlbumQueuePreview({
    spotifyAlbumId: "album1",
    albumName: "Album",
    artistNames: ["Artist"],
    releaseDate: "2026-01-01",
    playlist,
    playlistSnapshotId: "snap1",
    playlistItemUris: ["spotify:track:a", "spotify:track:x"],
    tracks: [track("a", 1), track("b", 2), track("c", 3)],
  });

  assert.equal(preview.status, "READY_TO_APPEND");
  assert.equal(preview.existingTrackOverlapCount, 1);
  assert.deepEqual(preview.appendUris, [
    "spotify:track:a",
    "spotify:track:b",
    "spotify:track:c",
  ]);
  assert.equal(preview.plannedPlaylistItemCountAfter, 5);
});

test("Gate 3 abstains when the exact edition sequence is already queued", () => {
  const preview = buildAlbumQueuePreview({
    spotifyAlbumId: "album1",
    albumName: "Album",
    artistNames: ["Artist"],
    releaseDate: null,
    playlist,
    playlistSnapshotId: "snap1",
    playlistItemUris: ["spotify:track:x", "spotify:track:a", "spotify:track:b"],
    tracks: [track("a", 1), track("b", 2)],
  });

  assert.equal(preview.status, "ALREADY_QUEUED");
  assert.equal(preview.appendUris.length, 0);
  assert.equal(preview.plannedPlaylistItemCountAfter, 3);
});

test("Gate 3 blocks a partial album when any track is unavailable in the user market", () => {
  const preview = buildAlbumQueuePreview({
    spotifyAlbumId: "album1",
    albumName: "Album",
    artistNames: ["Artist"],
    releaseDate: null,
    playlist,
    playlistSnapshotId: "snap1",
    playlistItemUris: [],
    tracks: [track("a", 1), track("b", 2, false)],
  });

  assert.equal(preview.status, "BLOCKED_UNAVAILABLE_TRACKS");
  assert.equal(preview.unavailableTrackCount, 1);
  assert.equal(preview.appendUris.length, 0);
});

function track(id: string, trackNumber: number, isPlayable = true): SpotifyAlbumCatalogTrack {
  return {
    id,
    name: `Track ${trackNumber}`,
    uri: `spotify:track:${id}`,
    durationMs: 180_000,
    discNumber: 1,
    trackNumber,
    isPlayable,
    artists: [{ id: "artist1", name: "Artist" }],
  };
}
