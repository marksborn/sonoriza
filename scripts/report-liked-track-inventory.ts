import { prisma } from "@/lib/prisma";
import { getLikedTrackInventory } from "@/services/music-preference/liked-track-inventory";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const report = await getLikedTrackInventory(user.id);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("========== LIKED-01 — GATE 1 READ-ONLY ==========");
  console.log(`User:                            ${user.email ?? user.id}`);
  console.log(`Generated at:                    ${report.generatedAt.toISOString()}`);
  console.log("\nSpotify Saved Tracks:");
  console.log(`  rows read:                     ${report.provider.rows}`);
  console.log(`  available:                     ${report.provider.availableRows}`);
  console.log(`  unavailable:                   ${report.provider.unavailableRows}`);
  console.log(`  invalid:                       ${report.provider.invalidRows}`);
  console.log(`  without canonical track id:    ${report.provider.rowsWithoutCanonicalTrackId}`);
  console.log(`  distinct canonical tracks:     ${report.provider.distinctCanonicalTracks}`);
  console.log(`  technical duplicate rows:      ${report.provider.duplicateTechnicalRows}`);
  console.log(`  distinct artists:              ${report.provider.distinctArtists}`);
  console.log(`  newest saved at:               ${iso(report.provider.newestAddedAt)}`);
  console.log(`  oldest saved at:               ${iso(report.provider.oldestAddedAt)}`);
  console.log(`  provider pages:                ${report.provider.pagesRead}`);
  console.log(`  provider calls:                ${report.provider.providerCalls}`);
  console.log(`  provider retries:              ${report.provider.retries}`);
  console.log(`  rate limits observed:          ${report.provider.rateLimitedCount}`);
  console.log(`  retry wait:                    ${report.provider.retryWaitMs} ms`);

  console.log("\nCanonical history overlap:");
  console.log(`  history tracks with Spotify id:${pad(report.local.historyCanonicalTracks)}`);
  console.log(`  liked tracks already known:    ${report.local.likedTracksKnownInHistory}`);
  console.log(`  liked tracks missing locally:  ${report.local.likedTracksMissingFromHistory}`);
  console.log(`  with ISRC evidence:            ${report.local.likedTracksWithIsrcEvidence}`);
  console.log(`  with artist-id evidence:       ${report.local.likedTracksWithPrimaryArtistIdEvidence}`);
  console.log(`  ISRC conflicts:                ${report.local.likedTracksWithIsrcConflict}`);
  console.log(`  artist-id conflicts:           ${report.local.likedTracksWithPrimaryArtistIdConflict}`);

  console.log("\nSynchronization finding:");
  console.log(`  page size:                     ${report.synchronization.pageSize}`);
  console.log(`  current addition strategy:     ${report.synchronization.existingAdditionStrategy}`);
  console.log("  additions:                     incremental watermark is viable");
  console.log("  removals/unlikes:              require reconciliation against a persisted library snapshot");
  console.log(`  current full-scan calls:       ${report.synchronization.fullScanProviderCalls}`);

  console.log("\nGate 1 is strictly read-only: no LIKE is persisted, no artist affinity is created, no source/planner state is changed, and Spotify is not written.");
}

function parseArgs(argv: string[]): { email: string; json: boolean } {
  let email = "";
  let json = false;

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return { email, json };
}

function iso(value: Date | null): string {
  return value?.toISOString() ?? "-";
}

function pad(value: number): string {
  return String(value).padStart(4, " ");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
