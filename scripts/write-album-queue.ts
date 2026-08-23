import { prisma } from "@/lib/prisma";
import {
  ALBUM_QUEUE_WRITE_POLICY,
  executeAlbumQueueWrite,
} from "@/services/album-discovery/queue-operation";

const args = parseArgs(process.argv.slice(2));

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const result = await executeAlbumQueueWrite({
    userId: user.id,
    spotifyAlbumId: args.albumId,
    playlistName: args.playlistName,
    expectedSnapshotId: args.expectedSnapshotId,
    expectedContentFingerprint: args.expectedContentFingerprint,
    confirmation: args.confirmation,
  });

  print({
    gate: "ALBUM-01 Gate 5",
    policy: ALBUM_QUEUE_WRITE_POLICY,
    user: user.email ?? user.id,
    ...result,
  });

  if (result.result === "POST_WRITE_VERIFICATION_FAILED") {
    throw new Error(`Gate 5 post-write verification failed: ${result.reason}`);
  }
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
