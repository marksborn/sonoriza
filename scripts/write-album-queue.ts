import { prisma } from "@/lib/prisma";
import { recordQueuedAlbumMemory } from "@/services/album-discovery/queue-memory";
import {
  buildAlbumQueuePreview,
  fingerprintPlaylistContent,
  resolveAlbumQueuePlaylist,
} from "@/services/album-discovery/queue-preview";
import {
  ALBUM_QUEUE_WRITE_POLICY,
  authorizeAlbumQueueWrite,
  verifyAlbumQueueAppend,
} from "@/services/album-discovery/queue-write";
import { SpotifyAlbumCatalogClient } from "@/services/spotify/album-catalog";
import { SpotifyAlbumQueuePreviewClient } from "@/services/spotify/album-queue-preview";
import { SpotifyClient } from "@/services/spotify/client";

const args = parseArgs(process.argv.slice(2));

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const queueClient = await SpotifyAlbumQueuePreviewClient.forUser(user.id);
  const albumCatalog = await SpotifyAlbumCatalogClient.forUser(user.id);
  const playlists = await queueClient.listCurrentUserPlaylists();
  const playlistResolution = resolveAlbumQueuePlaylist(playlists, args.playlistName);

  if (playlistResolution.status !== "RESOLVED" || !playlistResolution.playlist) {
    print({
      gate: "ALBUM-01 Gate 5",
      policy: ALBUM_QUEUE_WRITE_POLICY,
      user: user.email ?? user.id,
      playlistResolution,
      spotifyAlbumId: args.albumId,
      authorization: null,
      result: "ABSTAIN_PLAYLIST_UNRESOLVED",
      spotifyWrites: 0,
      databaseWrites: 0,
    });
    return;
  }

  const [album, tracks, playlistState] = await Promise.all([
    queueClient.getAlbum(args.albumId),
    albumCatalog.getAlbumTracks(args.albumId),
    queueClient.readPlaylistStable(playlistResolution.playlist.id),
  ]);

  if (album.albumType !== "album") {
    throw new Error(`Spotify item ${album.id} is album_type=${album.albumType}; full albums only`);
  }
  if (album.totalTracks !== tracks.length) {
    throw new Error(
      `Spotify album ${album.id} reported ${album.totalTracks} tracks but Gate 5 read ${tracks.length}; write aborted`,
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

  const authorization = authorizeAlbumQueueWrite({
    preview,
    expectedSnapshotId: args.expectedSnapshotId,
    expectedContentFingerprint: args.expectedContentFingerprint,
    confirmation: args.confirmation,
  });

  if (authorization.status !== "AUTHORIZED") {
    print({
      gate: "ALBUM-01 Gate 5",
      policy: ALBUM_QUEUE_WRITE_POLICY,
      user: user.email ?? user.id,
      playlist: playlistResolution.playlist,
      album: `${album.artistNames.join(", ")} — ${album.name}`,
      spotifyAlbumId: album.id,
      liveSnapshot: playlistState.snapshotId,
      expectedSnapshot: args.expectedSnapshotId,
      liveContentFingerprint: preview.playlistContentFingerprint,
      expectedContentFingerprint: args.expectedContentFingerprint,
      previewStatus: preview.status,
      authorization,
      result: "NO_WRITE",
      spotifyWrites: 0,
      databaseWrites: 0,
    });
    return;
  }

  const writer = await SpotifyClient.forUser(user.id);
  const writerSnapshot = await writer.appendPlaylistItems(preview.playlistId, preview.appendUris);
  const after = await queueClient.readPlaylistStable(preview.playlistId);
  const verification = verifyAlbumQueueAppend({
    beforeItemUris: playlistState.itemUris,
    afterItemUris: after.itemUris,
    appendedUris: preview.appendUris,
  });
  const contentFingerprintAfter = fingerprintPlaylistContent(after.itemUris);

  if (!verification.ok) {
    print({
      gate: "ALBUM-01 Gate 5",
      policy: ALBUM_QUEUE_WRITE_POLICY,
      user: user.email ?? user.id,
      playlist: playlistResolution.playlist,
      album: `${album.artistNames.join(", ")} — ${album.name}`,
      spotifyAlbumId: album.id,
      snapshotBefore: playlistState.snapshotId,
      contentFingerprintBefore: preview.playlistContentFingerprint,
      writerSnapshot,
      snapshotAfter: after.snapshotId,
      contentFingerprintAfter,
      appendedTrackCount: preview.appendUris.length,
      itemCountBefore: playlistState.itemUris.length,
      itemCountAfter: after.itemUris.length,
      authorization,
      verification,
      result: "POST_WRITE_VERIFICATION_FAILED",
      spotifyWrites: 1,
      databaseWrites: 0,
    });
    throw new Error(`Gate 5 post-write verification failed: ${verification.reason}`);
  }

  let memory;
  try {
    memory = await recordQueuedAlbumMemory({
      userId: user.id,
      spotifyAlbumId: album.id,
      artistName: album.artistNames.join(", "),
      albumName: album.name,
      playlistId: preview.playlistId,
      playlistName: preview.playlistName,
      writerSnapshot,
      contentFingerprint: contentFingerprintAfter,
      source: "CONTROLLED_QUEUE_WRITER",
    });
  } catch (error) {
    print({
      gate: "ALBUM-01 Gate 5",
      policy: ALBUM_QUEUE_WRITE_POLICY,
      user: user.email ?? user.id,
      playlist: playlistResolution.playlist,
      album: `${album.artistNames.join(", ")} — ${album.name}`,
      spotifyAlbumId: album.id,
      writerSnapshot,
      verification,
      result: "MEMORY_PERSISTENCE_FAILED_AFTER_VERIFIED_SPOTIFY_WRITE",
      memoryError: error instanceof Error ? error.message : String(error),
      spotifyWrites: 1,
      databaseWrites: 0,
    });
    throw error;
  }

  print({
    gate: "ALBUM-01 Gate 5",
    policy: ALBUM_QUEUE_WRITE_POLICY,
    user: user.email ?? user.id,
    playlist: playlistResolution.playlist,
    album: `${album.artistNames.join(", ")} — ${album.name}`,
    spotifyAlbumId: album.id,
    snapshotBefore: playlistState.snapshotId,
    contentFingerprintBefore: preview.playlistContentFingerprint,
    writerSnapshot,
    snapshotAfter: after.snapshotId,
    contentFingerprintAfter,
    appendedTrackCount: preview.appendUris.length,
    itemCountBefore: playlistState.itemUris.length,
    itemCountAfter: after.itemUris.length,
    authorization,
    verification,
    memory,
    result: "SUCCESS",
    spotifyWrites: 1,
    databaseWrites: 1,
  });
}

type Args = {
  email: string;
  albumId: string;
  playlistName: string;
  expectedSnapshotId: string;
  expectedContentFingerprint: string;
  confirmation: string | null;
};

function parseArgs(argv: string[]): Args {
  let email = "";
  let albumId = "";
  let playlistName = "Adicionar";
  let expectedSnapshotId = "";
  let expectedContentFingerprint = "";
  let confirmation: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--email=")) email = arg.slice("--email=".length).trim().toLowerCase();
    else if (arg.startsWith("--album-id=")) albumId = arg.slice("--album-id=".length).trim();
    else if (arg.startsWith("--playlist=")) playlistName = arg.slice("--playlist=".length).trim();
    else if (arg.startsWith("--expected-snapshot=")) expectedSnapshotId = arg.slice("--expected-snapshot=".length).trim();
    else if (arg.startsWith("--expected-content-fingerprint=")) {
      expectedContentFingerprint = arg.slice("--expected-content-fingerprint=".length).trim();
    } else if (arg.startsWith("--confirm=")) confirmation = arg.slice("--confirm=".length).trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email || !albumId || !playlistName || !expectedSnapshotId || !expectedContentFingerprint) {
    throw new Error(
      "Usage: npm run album:queue-write -- --email=<user> --album-id=<spotifyAlbumId> --expected-snapshot=<snapshot> --expected-content-fingerprint=<sha256:...> [--playlist=Adicionar] [--confirm=APPEND:<spotifyAlbumId>]",
    );
  }
  return {
    email,
    albumId,
    playlistName,
    expectedSnapshotId,
    expectedContentFingerprint,
    confirmation,
  };
}

function print(payload: Record<string, unknown>) {
  console.log("========== ALBUM-01 — GATE 5 CONTROLLED QUEUE WRITER ==========");
  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
