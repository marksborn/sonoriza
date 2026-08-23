import assert from "node:assert/strict";
import test from "node:test";

import type { AlbumQueuePreview } from "./queue-preview";
import { authorizeAlbumQueueWrite, confirmationTokenForAlbum, verifyAlbumQueueAppend } from "./queue-write";

const preview: AlbumQueuePreview = {
  policyVersion: "album-gate3-queue-preview-readonly-v2",
  status: "READY_TO_APPEND",
  reason: "FULL_EDITION_CAN_BE_APPENDED",
  spotifyAlbumId: "album1",
  albumName: "Album",
  artistNames: ["Artist"],
  releaseDate: "2026-01-01",
  playlistId: "playlist1",
  playlistName: "Adicionar",
  playlistSnapshotId: "snap1",
  playlistContentFingerprint: "sha256:content1",
  playlistItemCountBefore: 1,
  albumTrackCount: 2,
  albumDurationMs: 2000,
  unavailableTrackCount: 0,
  existingTrackOverlapCount: 0,
  appendUris: ["spotify:track:a", "spotify:track:b"],
  plannedPlaylistItemCountAfter: 3,
  tracks: [],
};

const authorizedInput = {
  preview,
  expectedSnapshotId: "snap1",
  expectedContentFingerprint: "sha256:content1",
  confirmation: "APPEND:album1",
};

test("requires exact confirmation, snapshot and content fingerprint", () => {
  const token = confirmationTokenForAlbum("album1");
  assert.equal(token, "APPEND:album1");
  assert.equal(
    authorizeAlbumQueueWrite({ ...authorizedInput, confirmation: null }).reason,
    "CONFIRMATION_REQUIRED",
  );
  assert.equal(
    authorizeAlbumQueueWrite({ ...authorizedInput, expectedSnapshotId: "old" }).reason,
    "EXPECTED_SNAPSHOT_MISMATCH",
  );
  assert.equal(
    authorizeAlbumQueueWrite({
      ...authorizedInput,
      expectedContentFingerprint: "sha256:different",
    }).reason,
    "EXPECTED_CONTENT_FINGERPRINT_MISMATCH",
  );
  assert.equal(authorizeAlbumQueueWrite(authorizedInput).status, "AUTHORIZED");
});

test("content fingerprint blocks stale snapshot false confidence", () => {
  const staleSnapshotButChangedContent = {
    ...preview,
    playlistSnapshotId: "snap1",
    playlistContentFingerprint: "sha256:new-content",
  };
  const result = authorizeAlbumQueueWrite({
    preview: staleSnapshotButChangedContent,
    expectedSnapshotId: "snap1",
    expectedContentFingerprint: "sha256:content1",
    confirmation: "APPEND:album1",
  });
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "EXPECTED_CONTENT_FINGERPRINT_MISMATCH");
});

test("refuses preview no longer ready", () => {
  const blocked = {
    ...preview,
    status: "ALREADY_QUEUED" as const,
    reason: "EXACT_EDITION_SEQUENCE_ALREADY_PRESENT" as const,
    appendUris: [],
  };
  assert.equal(
    authorizeAlbumQueueWrite({ ...authorizedInput, preview: blocked }).reason,
    "PREVIEW_NOT_READY",
  );
});

test("verifies exact prefix plus appended edition", () => {
  const ok = verifyAlbumQueueAppend({
    beforeItemUris: ["spotify:track:x", null],
    afterItemUris: ["spotify:track:x", null, "spotify:track:a", "spotify:track:b"],
    appendedUris: ["spotify:track:a", "spotify:track:b"],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, "EXACT_PREFIX_PLUS_EDITION");

  const changed = verifyAlbumQueueAppend({
    beforeItemUris: ["spotify:track:x"],
    afterItemUris: ["spotify:track:y", "spotify:track:a"],
    appendedUris: ["spotify:track:a"],
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, "PREEXISTING_PREFIX_CHANGED");
});
