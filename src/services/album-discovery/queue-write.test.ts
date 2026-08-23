import assert from "node:assert/strict";
import test from "node:test";

import type { AlbumQueuePreview } from "./queue-preview";
import { authorizeAlbumQueueWrite, confirmationTokenForAlbum, verifyAlbumQueueAppend } from "./queue-write";

const preview: AlbumQueuePreview = {
  policyVersion: "album-gate3-queue-preview-readonly-v1",
  status: "READY_TO_APPEND",
  reason: "FULL_EDITION_CAN_BE_APPENDED",
  spotifyAlbumId: "album1",
  albumName: "Album",
  artistNames: ["Artist"],
  releaseDate: "2026-01-01",
  playlistId: "playlist1",
  playlistName: "Adicionar",
  playlistSnapshotId: "snap1",
  playlistItemCountBefore: 1,
  albumTrackCount: 2,
  albumDurationMs: 2000,
  unavailableTrackCount: 0,
  existingTrackOverlapCount: 0,
  appendUris: ["spotify:track:a", "spotify:track:b"],
  plannedPlaylistItemCountAfter: 3,
  tracks: [],
};

test("requires exact confirmation and snapshot", () => {
  const token = confirmationTokenForAlbum("album1");
  assert.equal(token, "APPEND:album1");
  assert.equal(authorizeAlbumQueueWrite({ preview, expectedSnapshotId: "snap1", confirmation: null }).reason, "CONFIRMATION_REQUIRED");
  assert.equal(authorizeAlbumQueueWrite({ preview, expectedSnapshotId: "old", confirmation: token }).reason, "EXPECTED_SNAPSHOT_MISMATCH");
  assert.equal(authorizeAlbumQueueWrite({ preview, expectedSnapshotId: "snap1", confirmation: token }).status, "AUTHORIZED");
});

test("refuses preview no longer ready", () => {
  const blocked = { ...preview, status: "ALREADY_QUEUED" as const, reason: "EXACT_EDITION_SEQUENCE_ALREADY_PRESENT" as const, appendUris: [] };
  assert.equal(authorizeAlbumQueueWrite({ preview: blocked, expectedSnapshotId: "snap1", confirmation: "APPEND:album1" }).reason, "PREVIEW_NOT_READY");
});

test("verifies exact prefix plus appended edition", () => {
  const ok = verifyAlbumQueueAppend({ beforeItemUris: ["spotify:track:x", null], afterItemUris: ["spotify:track:x", null, "spotify:track:a", "spotify:track:b"], appendedUris: ["spotify:track:a", "spotify:track:b"] });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, "EXACT_PREFIX_PLUS_EDITION");

  const changed = verifyAlbumQueueAppend({ beforeItemUris: ["spotify:track:x"], afterItemUris: ["spotify:track:y", "spotify:track:a"], appendedUris: ["spotify:track:a"] });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, "PREEXISTING_PREFIX_CHANGED");
});
