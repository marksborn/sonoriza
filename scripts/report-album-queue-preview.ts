import { prisma } from "@/lib/prisma";
import {
  ALBUM_QUEUE_PREVIEW_POLICY,
  buildAlbumQueuePreview,
  resolveAlbumQueuePlaylist,
} from "@/services/album-discovery/queue-preview";
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
    const payload = {
      gate: "ALBUM-01 Gate 3",
      mode: "READ_ONLY",
      user: user.email ?? user.id,
      policy: ALBUM_QUEUE_PREVIEW_POLICY,
      playlistRequested: args.playlistName,
      playlistResolution,
      spotifyAlbumId: args.albumId,
      preview: null,
      providerMetrics: { queue: queueClient.getMetrics(), albumCatalog: albumCatalog.getMetrics() },
      safety: { spotifyWrites: 0, databaseWrites: 0, queueWrites: 0 },
    };
    print(payload, args.json);
    return;
  }

  const [album, tracks, playlistState] = await Promise.all([
    queueClient.getAlbum(args.albumId),
    albumCatalog.getAlbumTracks(args.albumId),
    queueClient.readPlaylistStable(playlistResolution.playlist.id),
  ]);

  if (album.albumType !== "album") {
    throw new Error(
      `Spotify item ${album.id} is album_type=${album.albumType}; ALBUM-01 v1 accepts full albums only`,
    );
  }
  if (album.totalTracks !== tracks.length) {
    throw new Error(
      `Spotify album ${album.id} reported ${album.totalTracks} tracks but Gate 3 read ${tracks.length}; preview aborted to preserve album integrity`,
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

  const payload = {
    gate: "ALBUM-01 Gate 3",
    mode: "READ_ONLY",
    user: user.email ?? user.id,
    policy: ALBUM_QUEUE_PREVIEW_POLICY,
    playlistRequested: args.playlistName,
    playlistResolution,
    spotifyAlbumId: args.albumId,
    preview,
    providerMetrics: { queue: queueClient.getMetrics(), albumCatalog: albumCatalog.getMetrics() },
    safety: {
      spotifyWrites: 0,
      databaseWrites: 0,
      queueWrites: 0,
      music01Changed: false,
      cooldownBypassExecuted: false,
    },
  };
  print(payload, args.json);
}

function print(payload: Record<string, unknown>, json: boolean) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const resolution = payload.playlistResolution as ReturnType<typeof resolveAlbumQueuePlaylist>;
  console.log("========== ALBUM-01 — GATE 3 QUEUE PREVIEW READ-ONLY ==========");
  console.log(`User:                    ${String(payload.user)}`);
  console.log(`Playlist requested:      ${String(payload.playlistRequested)}`);
  console.log(`Playlist resolution:     ${resolution.status} / ${resolution.reason}`);
  console.log(`Spotify album id:        ${String(payload.spotifyAlbumId)}`);
  console.log(`Policy:                  ${ALBUM_QUEUE_PREVIEW_POLICY.version}`);
  console.log("Mode:                    READ_ONLY — zero Spotify/database/queue writes");

  if (resolution.status !== "RESOLVED" || !payload.preview) {
    if (resolution.alternatives.length > 0) {
      console.log("Playlist alternatives:");
      for (const playlist of resolution.alternatives) {
        console.log(`  ${playlist.name} — id=${playlist.id} owner=${playlist.ownerId ?? "?"}`);
      }
    }
    return;
  }

  const preview = payload.preview as ReturnType<typeof buildAlbumQueuePreview>;
  console.log(`Playlist id:             ${preview.playlistId}`);
  console.log(`Playlist snapshot:       ${preview.playlistSnapshotId}`);
  console.log(`Playlist items before:   ${preview.playlistItemCountBefore}`);
  console.log(`Album:                   ${preview.artistNames.join(", ")} — ${preview.albumName}`);
  console.log(`Release:                 ${preview.releaseDate ?? "?"}`);
  console.log(`Album tracks:            ${preview.albumTrackCount}`);
  console.log(`Album duration:          ${formatDuration(preview.albumDurationMs)}`);
  console.log(`Unavailable tracks:      ${preview.unavailableTrackCount}`);
  console.log(`Existing URI overlaps:   ${preview.existingTrackOverlapCount}`);
  console.log(`Preview status:          ${preview.status} / ${preview.reason}`);
  console.log(`Would append:            ${preview.appendUris.length} tracks`);
  console.log(`Playlist items after:    ${preview.plannedPlaylistItemCountAfter}`);
  console.log("Tracklist:");
  for (const track of preview.tracks) {
    console.log(
      `  ${String(track.discNumber).padStart(2, "0")}.${String(track.trackNumber).padStart(2, "0")} ${track.name}` +
        ` — ${formatDuration(track.durationMs)} — ${track.isPlayable ? "PLAYABLE" : "UNAVAILABLE"}` +
        ` — ${track.uri}`,
    );
  }
}

type Args = {
  email: string;
  albumId: string;
  playlistName: string;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  let email = "";
  let albumId = "";
  let playlistName = "Adicionar";
  let json = false;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim().toLowerCase();
      continue;
    }
    if (arg.startsWith("--album-id=")) {
      albumId = arg.slice("--album-id=".length).trim();
      continue;
    }
    if (arg.startsWith("--playlist=")) {
      playlistName = arg.slice("--playlist=".length).trim();
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email || !albumId || !playlistName) {
    throw new Error(
      "Usage: npm run album:queue-preview -- --email=<user> --album-id=<spotifyAlbumId> [--playlist=Adicionar] [--json]",
    );
  }
  return { email, albumId, playlistName, json };
}

function formatDuration(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
