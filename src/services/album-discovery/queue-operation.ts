import { prisma } from "@/lib/prisma";
import {
  isPersistentlyQueued,
  recordQueuedAlbumMemory,
} from "@/services/album-discovery/queue-memory";
import {
  buildAlbumQueuePreview,
  fingerprintPlaylistContent,
  resolveAlbumQueuePlaylist,
  type AlbumQueuePreview,
  type AlbumQueuePlaylistResolution,
  type AlbumQueuePlaylistSummary,
} from "@/services/album-discovery/queue-preview";
import {
  ALBUM_QUEUE_WRITE_POLICY,
  authorizeAlbumQueueWrite,
  verifyAlbumQueueAppend,
  type AlbumQueueWriteAuthorization,
  type AlbumQueueWriteVerification,
} from "@/services/album-discovery/queue-write";
import { SpotifyAlbumCatalogClient } from "@/services/spotify/album-catalog";
import {
  SpotifyAlbumQueuePreviewClient,
  type SpotifyAlbumQueueAlbum,
} from "@/services/spotify/album-queue-preview";
import { SpotifyClient } from "@/services/spotify/client";

export type AlbumQueueReviewResult =
  | {
      status: "PERSISTED_QUEUED";
      spotifyAlbumId: string;
      persistedMemory: Awaited<ReturnType<typeof findAlbumMemory>>;
    }
  | {
      status: "PLAYLIST_UNRESOLVED";
      spotifyAlbumId: string;
      playlistResolution: AlbumQueuePlaylistResolution;
    }
  | {
      status: "PREVIEW_READY";
      spotifyAlbumId: string;
      playlist: AlbumQueuePlaylistSummary;
      album: SpotifyAlbumQueueAlbum;
      preview: AlbumQueuePreview;
    };

export type AlbumQueueWriteResult = {
  result:
    | "SUCCESS"
    | "NO_WRITE"
    | "ABSTAIN_PLAYLIST_UNRESOLVED"
    | "POST_WRITE_VERIFICATION_FAILED";
  reason: string;
  spotifyWrites: 0 | 1;
  databaseWrites: 0 | 1;
  spotifyAlbumId: string;
  playlist?: AlbumQueuePlaylistSummary;
  album?: string;
  previewStatus?: AlbumQueuePreview["status"];
  authorization?: AlbumQueueWriteAuthorization | null;
  verification?: AlbumQueueWriteVerification;
  appendedTrackCount?: number;
  itemCountBefore?: number;
  itemCountAfter?: number;
  memory?: Awaited<ReturnType<typeof recordQueuedAlbumMemory>>;
  persistedMemory?: Awaited<ReturnType<typeof findAlbumMemory>>;
};

export async function getAlbumQueueReview(
  userId: string,
  spotifyAlbumId: string,
  playlistName = "Adicionar",
): Promise<AlbumQueueReviewResult> {
  const persistedMemory = await findAlbumMemory(userId, spotifyAlbumId);
  if (isPersistentlyQueued(persistedMemory)) {
    return {
      status: "PERSISTED_QUEUED",
      spotifyAlbumId,
      persistedMemory,
    };
  }

  const context = await loadQueueContext(userId, spotifyAlbumId, playlistName);
  if (context.status === "PLAYLIST_UNRESOLVED") {
    return {
      status: "PLAYLIST_UNRESOLVED",
      spotifyAlbumId,
      playlistResolution: context.playlistResolution,
    };
  }

  return {
    status: "PREVIEW_READY",
    spotifyAlbumId,
    playlist: context.playlist,
    album: context.album,
    preview: context.preview,
  };
}

export async function executeAlbumQueueWrite(input: {
  userId: string;
  spotifyAlbumId: string;
  playlistName?: string;
  expectedSnapshotId: string;
  expectedContentFingerprint: string;
  confirmation: string | null;
}): Promise<AlbumQueueWriteResult> {
  const playlistName = input.playlistName ?? "Adicionar";
  const persistedMemory = await findAlbumMemory(input.userId, input.spotifyAlbumId);
  if (isPersistentlyQueued(persistedMemory)) {
    return {
      result: "NO_WRITE",
      reason: "PERSISTED_QUEUED_MEMORY",
      spotifyWrites: 0,
      databaseWrites: 0,
      spotifyAlbumId: input.spotifyAlbumId,
      persistedMemory,
    };
  }

  const context = await loadQueueContext(input.userId, input.spotifyAlbumId, playlistName);
  if (context.status === "PLAYLIST_UNRESOLVED") {
    return {
      result: "ABSTAIN_PLAYLIST_UNRESOLVED",
      reason: context.playlistResolution.reason,
      spotifyWrites: 0,
      databaseWrites: 0,
      spotifyAlbumId: input.spotifyAlbumId,
    };
  }

  const authorization = authorizeAlbumQueueWrite({
    preview: context.preview,
    expectedSnapshotId: input.expectedSnapshotId,
    expectedContentFingerprint: input.expectedContentFingerprint,
    confirmation: input.confirmation,
  });

  if (authorization.status !== "AUTHORIZED") {
    return {
      result: "NO_WRITE",
      reason: authorization.reason,
      spotifyWrites: 0,
      databaseWrites: 0,
      spotifyAlbumId: context.album.id,
      playlist: context.playlist,
      album: `${context.album.artistNames.join(", ")} — ${context.album.name}`,
      previewStatus: context.preview.status,
      authorization,
    };
  }

  const writer = await SpotifyClient.forUser(input.userId);
  const writerSnapshot = await writer.appendPlaylistItems(
    context.preview.playlistId,
    context.preview.appendUris,
  );
  const after = await context.queueClient.readPlaylistStable(context.preview.playlistId);
  const verification = verifyAlbumQueueAppend({
    beforeItemUris: context.playlistState.itemUris,
    afterItemUris: after.itemUris,
    appendedUris: context.preview.appendUris,
  });
  const contentFingerprintAfter = fingerprintPlaylistContent(after.itemUris);

  if (!verification.ok) {
    return {
      result: "POST_WRITE_VERIFICATION_FAILED",
      reason: verification.reason,
      spotifyWrites: 1,
      databaseWrites: 0,
      spotifyAlbumId: context.album.id,
      playlist: context.playlist,
      album: `${context.album.artistNames.join(", ")} — ${context.album.name}`,
      previewStatus: context.preview.status,
      authorization,
      verification,
      appendedTrackCount: context.preview.appendUris.length,
      itemCountBefore: context.playlistState.itemUris.length,
      itemCountAfter: after.itemUris.length,
    };
  }

  const memory = await recordQueuedAlbumMemory({
    userId: input.userId,
    spotifyAlbumId: context.album.id,
    artistName: context.album.artistNames.join(", "),
    albumName: context.album.name,
    playlistId: context.preview.playlistId,
    playlistName: context.preview.playlistName,
    writerSnapshot,
    contentFingerprint: contentFingerprintAfter,
    source: "CONTROLLED_QUEUE_WRITER",
  });

  return {
    result: "SUCCESS",
    reason: "VERIFIED_APPEND_AND_QUEUED_MEMORY_PERSISTED",
    spotifyWrites: 1,
    databaseWrites: 1,
    spotifyAlbumId: context.album.id,
    playlist: context.playlist,
    album: `${context.album.artistNames.join(", ")} — ${context.album.name}`,
    previewStatus: context.preview.status,
    authorization,
    verification,
    appendedTrackCount: context.preview.appendUris.length,
    itemCountBefore: context.playlistState.itemUris.length,
    itemCountAfter: after.itemUris.length,
    memory,
  };
}

export { ALBUM_QUEUE_WRITE_POLICY };

async function findAlbumMemory(userId: string, spotifyAlbumId: string) {
  return prisma.albumRecommendationMemory.findUnique({
    where: {
      userId_spotifyAlbumId: {
        userId,
        spotifyAlbumId,
      },
    },
  });
}

async function loadQueueContext(userId: string, spotifyAlbumId: string, playlistName: string) {
  const queueClient = await SpotifyAlbumQueuePreviewClient.forUser(userId);
  const albumCatalog = await SpotifyAlbumCatalogClient.forUser(userId);
  const playlists = await queueClient.listCurrentUserPlaylists();
  const playlistResolution = resolveAlbumQueuePlaylist(playlists, playlistName);

  if (playlistResolution.status !== "RESOLVED" || !playlistResolution.playlist) {
    return {
      status: "PLAYLIST_UNRESOLVED" as const,
      playlistResolution,
    };
  }

  const [album, tracks, playlistState] = await Promise.all([
    queueClient.getAlbum(spotifyAlbumId),
    albumCatalog.getAlbumTracks(spotifyAlbumId),
    queueClient.readPlaylistStable(playlistResolution.playlist.id),
  ]);

  if (album.albumType !== "album") {
    throw new Error(`Spotify item ${album.id} is album_type=${album.albumType}; full albums only`);
  }
  if (album.totalTracks !== tracks.length) {
    throw new Error(
      `Spotify album ${album.id} reported ${album.totalTracks} tracks but Sonoriza read ${tracks.length}; operation aborted`,
    );
  }

  const preview = buildAlbumQueuePreview({
    spotifyAlbumId: album.id,
    albumName: album.name,
    artistNames: album.artistNames,
    releaseDate: album.releaseDate,
    playlist: playlistResolution.playlist,
    playlistSnapshotId: playlistState.snapshotId,
    playlistItemUris: playlistState.itemUris,
    tracks,
  });

  return {
    status: "READY" as const,
    queueClient,
    playlist: playlistResolution.playlist,
    album,
    playlistState,
    preview,
  };
}
