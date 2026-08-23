import { createHash } from "node:crypto";

import type { SpotifyAlbumCatalogTrack } from "@/services/spotify/album-catalog";

export const ALBUM_QUEUE_PREVIEW_POLICY = {
  version: "album-gate3-queue-preview-readonly-v2",
  playlistResolution: "EXACT_NORMALIZED_NAME_UNIQUE_OR_ABSTAIN",
  editionIdentity: "SPOTIFY_ALBUM_ID",
  albumIntegrity: "APPEND_COMPLETE_PLAYABLE_EDITION_IN_DISC_TRACK_ORDER_OR_ABSTAIN",
  duplicatePolicy:
    "IF_EXACT_EDITION_URI_SEQUENCE_ALREADY_EXISTS_CONTIGUOUSLY_ABSTAIN; OTHERWISE_APPEND_FULL_EDITION_EVEN_IF_INDIVIDUAL_TRACKS_OVERLAP",
  contentFingerprint: "SHA256_ORDERED_PLAYLIST_URI_OR_NULL_SEQUENCE",
  writes: "NONE",
} as const;

export type AlbumQueuePlaylistSummary = {
  id: string;
  name: string;
  ownerId: string | null;
};

export type AlbumQueuePlaylistResolution =
  | {
      status: "RESOLVED";
      reason: "EXACT_PLAYLIST_NAME";
      playlist: AlbumQueuePlaylistSummary;
      alternatives: AlbumQueuePlaylistSummary[];
    }
  | {
      status: "NOT_FOUND";
      reason: "PLAYLIST_NOT_FOUND";
      playlist: null;
      alternatives: AlbumQueuePlaylistSummary[];
    }
  | {
      status: "AMBIGUOUS";
      reason: "PLAYLIST_NAME_AMBIGUOUS";
      playlist: null;
      alternatives: AlbumQueuePlaylistSummary[];
    };

export type AlbumQueuePreview = {
  policyVersion: typeof ALBUM_QUEUE_PREVIEW_POLICY.version;
  status: "READY_TO_APPEND" | "ALREADY_QUEUED" | "BLOCKED_UNAVAILABLE_TRACKS";
  reason:
    | "FULL_EDITION_CAN_BE_APPENDED"
    | "EXACT_EDITION_SEQUENCE_ALREADY_PRESENT"
    | "EDITION_HAS_UNPLAYABLE_TRACKS";
  spotifyAlbumId: string;
  albumName: string;
  artistNames: string[];
  releaseDate: string | null;
  playlistId: string;
  playlistName: string;
  playlistSnapshotId: string;
  playlistContentFingerprint: string;
  playlistItemCountBefore: number;
  albumTrackCount: number;
  albumDurationMs: number;
  unavailableTrackCount: number;
  existingTrackOverlapCount: number;
  appendUris: string[];
  plannedPlaylistItemCountAfter: number;
  tracks: Array<{
    uri: string;
    name: string;
    discNumber: number;
    trackNumber: number;
    durationMs: number;
    isPlayable: boolean;
  }>;
};

export function resolveAlbumQueuePlaylist(
  playlists: AlbumQueuePlaylistSummary[],
  requestedName: string,
): AlbumQueuePlaylistResolution {
  const key = normalized(requestedName);
  const exact = playlists.filter((playlist) => normalized(playlist.name) === key);

  if (exact.length === 0) {
    return {
      status: "NOT_FOUND",
      reason: "PLAYLIST_NOT_FOUND",
      playlist: null,
      alternatives: [],
    };
  }
  if (exact.length > 1) {
    return {
      status: "AMBIGUOUS",
      reason: "PLAYLIST_NAME_AMBIGUOUS",
      playlist: null,
      alternatives: exact,
    };
  }
  return {
    status: "RESOLVED",
    reason: "EXACT_PLAYLIST_NAME",
    playlist: exact[0]!,
    alternatives: [],
  };
}

export function buildAlbumQueuePreview(input: {
  spotifyAlbumId: string;
  albumName: string;
  artistNames: string[];
  releaseDate: string | null;
  playlist: AlbumQueuePlaylistSummary;
  playlistSnapshotId: string;
  playlistItemUris: Array<string | null>;
  tracks: SpotifyAlbumCatalogTrack[];
}): AlbumQueuePreview {
  const orderedTracks = [...input.tracks].sort(
    (a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber || a.id.localeCompare(b.id),
  );
  const unavailableTrackCount = orderedTracks.filter((track) => !track.isPlayable).length;
  const albumUris = orderedTracks.map((track) => track.uri);
  const existingUris = new Set(
    input.playlistItemUris.filter((uri): uri is string => typeof uri === "string" && uri.length > 0),
  );
  const existingTrackOverlapCount = albumUris.filter((uri) => existingUris.has(uri)).length;
  const alreadyQueued = containsContiguousUriSequence(input.playlistItemUris, albumUris);
  const albumDurationMs = orderedTracks.reduce((sum, track) => sum + Math.max(0, track.durationMs), 0);

  let status: AlbumQueuePreview["status"];
  let reason: AlbumQueuePreview["reason"];
  let appendUris: string[];

  if (unavailableTrackCount > 0 || orderedTracks.length === 0) {
    status = "BLOCKED_UNAVAILABLE_TRACKS";
    reason = "EDITION_HAS_UNPLAYABLE_TRACKS";
    appendUris = [];
  } else if (alreadyQueued) {
    status = "ALREADY_QUEUED";
    reason = "EXACT_EDITION_SEQUENCE_ALREADY_PRESENT";
    appendUris = [];
  } else {
    status = "READY_TO_APPEND";
    reason = "FULL_EDITION_CAN_BE_APPENDED";
    appendUris = albumUris;
  }

  return {
    policyVersion: ALBUM_QUEUE_PREVIEW_POLICY.version,
    status,
    reason,
    spotifyAlbumId: input.spotifyAlbumId,
    albumName: input.albumName,
    artistNames: [...input.artistNames],
    releaseDate: input.releaseDate,
    playlistId: input.playlist.id,
    playlistName: input.playlist.name,
    playlistSnapshotId: input.playlistSnapshotId,
    playlistContentFingerprint: fingerprintPlaylistContent(input.playlistItemUris),
    playlistItemCountBefore: input.playlistItemUris.length,
    albumTrackCount: orderedTracks.length,
    albumDurationMs,
    unavailableTrackCount,
    existingTrackOverlapCount,
    appendUris,
    plannedPlaylistItemCountAfter: input.playlistItemUris.length + appendUris.length,
    tracks: orderedTracks.map((track) => ({
      uri: track.uri,
      name: track.name,
      discNumber: track.discNumber,
      trackNumber: track.trackNumber,
      durationMs: track.durationMs,
      isPlayable: track.isPlayable,
    })),
  };
}

export function fingerprintPlaylistContent(itemUris: Array<string | null>): string {
  const encoded = JSON.stringify(itemUris);
  return `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

export function containsContiguousUriSequence(
  haystack: Array<string | null>,
  needle: string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}
