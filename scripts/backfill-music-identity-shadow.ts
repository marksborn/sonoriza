import { prisma } from "@/lib/prisma";
import { runMusicIdentityShadowBackfill } from "@/services/music-identity/shadow-backfill";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runMusicIdentityShadowBackfill({
    userId: args.userId,
    write: args.write,
  });

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("========== MUSIC-IDENTITY-01 — GATE 2B SHADOW BACKFILL ==========");
  console.log(`Mode:                         ${summary.mode}`);
  console.log(`User:                         ${summary.userId}`);
  console.log(`Liked source rows:            ${summary.sourceRows.likedTrackPreferences}`);
  console.log(`Spotify event rows:           ${summary.sourceRows.spotifyListeningEvents}`);
  console.log(`Distinct Spotify tracks:      ${summary.distinctSpotifyTracks}`);
  console.log(`Candidate tracks:             ${summary.candidateTracks}`);
  console.log(`Skipped incomplete:           ${summary.skippedIncompleteTracks}`);
  console.log(`Skipped conflict:             ${summary.skippedConflictTracks}`);
  console.log(`Already present track refs:   ${summary.alreadyPresentTrackRefs}`);
  console.log("\nCanonical rows this run/planned:");
  console.log(`  ArtistIdentity:             ${summary.created.artistIdentities}`);
  console.log(`  ArtistProviderRef:          ${summary.created.artistProviderRefs}`);
  console.log(`  SongIdentity:               ${summary.created.songIdentities}`);
  console.log(`  RecordingIdentity:          ${summary.created.recordingIdentities}`);
  console.log(`  TrackProviderRef:           ${summary.created.trackProviderRefs}`);
  console.log(`  AlbumIdentity:              ${summary.created.albumIdentities}`);
  console.log(`  AlbumReleaseIdentity:       ${summary.created.albumReleaseIdentities}`);
  console.log(`  AlbumReleaseProviderRef:    ${summary.created.albumReleaseProviderRefs}`);

  if (!args.write) {
    console.log("\nDRY_RUN: nenhuma linha foi criada. Use --write explicitamente para persistir o shadow backfill.");
  } else {
    console.log("\nWRITE concluído: somente tabelas canônicas/provider-ref do Gate 2A foram preenchidas; nenhum consumer produtivo foi alterado.");
  }
}

function parseArgs(argv: string[]): {
  userId: string;
  write: boolean;
  json: boolean;
} {
  let userId = "";
  let write = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--user=")) {
      userId = arg.slice("--user=".length).trim();
      continue;
    }
    if (arg === "--user") {
      userId = argv[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!userId) {
    throw new Error("--user=<Sonoriza user id> is required; all-user backfill is intentionally unsupported");
  }

  return { userId, write, json };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
