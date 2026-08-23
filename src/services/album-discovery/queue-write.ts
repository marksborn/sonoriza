import type { AlbumQueuePreview } from "./queue-preview";

export const ALBUM_QUEUE_WRITE_POLICY = {
  version: "album-gate4-queue-writer-controlled-v1",
  execution:
    "EXPLICIT_ALBUM_ID_PLUS_EXPECTED_PLAYLIST_SNAPSHOT_PLUS_EXACT_CONFIRMATION_TOKEN",
  mutation: "APPEND_ONLY_COMPLETE_EDITION",
  preWrite:
    "REBUILD_GATE3_PREVIEW_AND_REQUIRE_READY_TO_APPEND_WITH_UNCHANGED_EXPECTED_SNAPSHOT",
  postWrite:
    "REQUIRE_EXACT_PREVIOUS_PLAYLIST_PREFIX_PLUS_COMPLETE_EDITION_SUFFIX",
  duplicatePolicy: "NEVER_WRITE_IF_GATE3_REPORTS_ALREADY_QUEUED",
  rollback: "NONE_AUTOMATIC; POST_WRITE_MISMATCH_IS_FATAL_AND_AUDITABLE",
} as const;

export type AlbumQueueWriteAuthorization =
  | {
      status: "AUTHORIZED";
      reason: "EXPLICIT_CONFIRMATION_MATCHED";
      expectedConfirmation: string;
    }
  | {
      status: "ABSTAIN";
      reason:
        | "PREVIEW_NOT_READY"
        | "EXPECTED_SNAPSHOT_MISMATCH"
        | "CONFIRMATION_REQUIRED"
        | "CONFIRMATION_MISMATCH";
      expectedConfirmation: string;
    };

export type AlbumQueueWriteVerification = {
  ok: boolean;
  reason:
    | "EXACT_PREFIX_PLUS_EDITION"
    | "PLAYLIST_LENGTH_MISMATCH"
    | "PREEXISTING_PREFIX_CHANGED"
    | "APPENDED_EDITION_MISMATCH";
  expectedItemCount: number;
  actualItemCount: number;
};

export function confirmationTokenForAlbum(spotifyAlbumId: string): string {
  return `APPEND:${spotifyAlbumId}`;
}

export function authorizeAlbumQueueWrite(input: {
  preview: AlbumQueuePreview;
  expectedSnapshotId: string;
  confirmation: string | null;
}): AlbumQueueWriteAuthorization {
  const expectedConfirmation = confirmationTokenForAlbum(input.preview.spotifyAlbumId);

  if (input.preview.status !== "READY_TO_APPEND") {
    return { status: "ABSTAIN", reason: "PREVIEW_NOT_READY", expectedConfirmation };
  }
  if (input.preview.playlistSnapshotId !== input.expectedSnapshotId) {
    return {
      status: "ABSTAIN",
      reason: "EXPECTED_SNAPSHOT_MISMATCH",
      expectedConfirmation,
    };
  }
  if (!input.confirmation) {
    return { status: "ABSTAIN", reason: "CONFIRMATION_REQUIRED", expectedConfirmation };
  }
  if (input.confirmation !== expectedConfirmation) {
    return { status: "ABSTAIN", reason: "CONFIRMATION_MISMATCH", expectedConfirmation };
  }
  return { status: "AUTHORIZED", reason: "EXPLICIT_CONFIRMATION_MATCHED", expectedConfirmation };
}

export function verifyAlbumQueueAppend(input: {
  beforeItemUris: Array<string | null>;
  afterItemUris: Array<string | null>;
  appendedUris: string[];
}): AlbumQueueWriteVerification {
  const expectedItemCount = input.beforeItemUris.length + input.appendedUris.length;
  const actualItemCount = input.afterItemUris.length;

  if (actualItemCount !== expectedItemCount) {
    return {
      ok: false,
      reason: "PLAYLIST_LENGTH_MISMATCH",
      expectedItemCount,
      actualItemCount,
    };
  }

  for (let index = 0; index < input.beforeItemUris.length; index += 1) {
    if (input.afterItemUris[index] !== input.beforeItemUris[index]) {
      return {
        ok: false,
        reason: "PREEXISTING_PREFIX_CHANGED",
        expectedItemCount,
        actualItemCount,
      };
    }
  }

  for (let offset = 0; offset < input.appendedUris.length; offset += 1) {
    const afterIndex = input.beforeItemUris.length + offset;
    if (input.afterItemUris[afterIndex] !== input.appendedUris[offset]) {
      return {
        ok: false,
        reason: "APPENDED_EDITION_MISMATCH",
        expectedItemCount,
        actualItemCount,
      };
    }
  }

  return {
    ok: true,
    reason: "EXACT_PREFIX_PLUS_EDITION",
    expectedItemCount,
    actualItemCount,
  };
}
