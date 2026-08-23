import { prisma } from "@/lib/prisma";
import { recordQueuedAlbumMemory } from "@/services/album-discovery/queue-memory";
import { buildAlbumQueuePreview, resolveAlbumQueuePlaylist } from "@/services/album-discovery/queue-preview";
import { SpotifyAlbumCatalogClient } from "@/services/spotify/album-catalog";
import { SpotifyAlbumQueuePreviewClient } from "@/services/spotify/album-queue-preview";

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
      mode: "CONTROLLED_DB_MEMORY_RECONCILIATION",
      user: user.email ?? user.id,
      spotifyAlbumId: args.albumId,
      playlistResolution,
      result: "NO_WRITE",
      spotifyWrites: 0,
      databaseWrites: 0,
    });
    return;
  }

  const [album, tracks, playlistState, existingMemory] = await Promise.all([
    queueClient.getAlbum(args.albumId),
    albumCatalog.getAlbumTracks(args.albumId),
    queueClient.readPlaylistStable(playlistResolution.playlist.id),
    prisma.albumRecommendationMemory.findUnique({
      where: {
        userId_spotifyAlbumId: {
          userId: user.id,
          spotifyAlbumId: args.albumId,
        },
      },
    }),
  ]);

  if (album.albumType !== "album") {
    throw new Error(`Spotify item ${album.id} is album_type=${album.albumType}; full albums only`);
  }
  if (album.totalTracks !== tracks.length) {
    throw new Error(
      `Spotify album ${album.id} reported ${album.totalTracks} tracks but reconciliation read ${tracks.length}`,
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
  const expectedConfirmation = `RECORD_QUEUED:${album.id}`;

  if (preview.status !== "ALREADY_QUEUED") {
    print({
      gate: "ALBUM-01 Gate 5",
      mode: "CONTROLLED_DB_MEMORY_RECONCILIATION",
      user: user.email ?? user.id,
      spotifyAlbumId: album.id,
      album: `${album.artistNames.join(", ")} — ${album.name}`,
      previewStatus: preview.status,
      existingMemory,
      authorization: {
        status: "ABSTAIN",
        reason: "EXACT_EDITION_NOT_PRESENT",
        expectedConfirmation,
      },
      result: "NO_WRITE",
      spotifyWrites: 0,
      databaseWrites: 0,
    });
    return;
  }

  if (args.confirmation !== expectedConfirmation) {
    print({
      gate: "ALBUM-01 Gate 5",
      mode: "CONTROLLED_DB_MEMORY_RECONCILIATION",
      user: user.email ?? user.id,
      spotifyAlbumId: album.id,
      album: `${album.artistNames.join(", ")} — ${album.name}`,
      previewStatus: preview.status,
      playlistSnapshot: preview.playlistSnapshotId,
      playlistContentFingerprint: preview.playlistContentFingerprint,
      existingMemory,
      authorization: {
        status: "ABSTAIN",
        reason: args.confirmation ? "CONFIRMATION_MISMATCH" : "CONFIRMATION_REQUIRED",
        expectedConfirmation,
      },
      result: "NO_WRITE",
      spotifyWrites: 0,
      databaseWrites: 0,
    });
    return;
  }

  const memory = await recordQueuedAlbumMemory({
    userId: user.id,
    spotifyAlbumId: album.id,
    artistName: album.artistNames.join(", "),
    albumName: album.name,
    playlistId: preview.playlistId,
    playlistName: preview.playlistName,
    writerSnapshot: preview.playlistSnapshotId,
    contentFingerprint: preview.playlistContentFingerprint,
    source: "RECONCILED_EXISTING_PLAYLIST",
  });

  print({
    gate: "ALBUM-01 Gate 5",
    mode: "CONTROLLED_DB_MEMORY_RECONCILIATION",
    user: user.email ?? user.id,
    spotifyAlbumId: album.id,
    album: `${album.artistNames.join(", ")} — ${album.name}`,
    previewStatus: preview.status,
    authorization: {
      status: "AUTHORIZED",
      reason: "EXACT_CONFIRMATION_MATCHED",
      expectedConfirmation,
    },
    memory,
    result: "SUCCESS",
    spotifyWrites: 0,
    databaseWrites: 1,
  });
}

type Args = {
  email: string;
  albumId: string;
  playlistName: string;
  confirmation: string | null;
};

function parseArgs(argv: string[]): Args {
  let email = "";
  let albumId = "";
  let playlistName = "Adicionar";
  let confirmation: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--email=")) email = arg.slice("--email=".length).trim().toLowerCase();
    else if (arg.startsWith("--album-id=")) albumId = arg.slice("--album-id=".length).trim();
    else if (arg.startsWith("--playlist=")) playlistName = arg.slice("--playlist=".length).trim();
    else if (arg.startsWith("--confirm=")) confirmation = arg.slice("--confirm=".length).trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!email || !albumId || !playlistName) {
    throw new Error(
      "Usage: npm run album:queue-memory -- --email=<user> --album-id=<spotifyAlbumId> [--playlist=Adicionar] [--confirm=RECORD_QUEUED:<spotifyAlbumId>]",
    );
  }
  return { email, albumId, playlistName, confirmation };
}

function print(payload: Record<string, unknown>) {
  console.log("========== ALBUM-01 — GATE 5 QUEUED MEMORY ==========");
  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
