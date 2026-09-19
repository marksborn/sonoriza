import { prisma } from "@/lib/prisma";
import { runMusicIdentityShadowCoverageAudit } from "@/services/music-identity/shadow-coverage-audit";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runMusicIdentityShadowCoverageAudit(args.userId);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("========== MUSIC-IDENTITY-01 — GATE 2C COVERAGE SHADOW ==========");
  console.log(`Mode:                            ${summary.mode}`);
  console.log(`User:                            ${summary.userId}`);
  console.log(`Authority:                       ${summary.authority.basis}`);
  console.log(`Interpretation:                  ${summary.authority.interpretation}`);
  console.log(`Live Spotify snapshot verified:  ${summary.authority.liveSpotifySnapshotVerified}`);
  console.log("\nScope:");
  console.log(`  Enabled targets:               ${summary.scope.enabledTargets}`);
  console.log(`  Configured music sources:      ${summary.scope.configuredMusicSources}`);
  console.log(`  Enabled music sources:         ${summary.scope.enabledMusicSources}`);
  console.log(`  Reachable music sources:       ${summary.scope.reachableMusicSources}`);
  console.log(`  Unreachable enabled sources:   ${summary.scope.unreachableEnabledMusicSources}`);
  console.log("\nPersisted cache:");
  console.log(`  Full valid sources:            ${summary.cache.fullValidSources}`);
  console.log(`  Partial valid sources:         ${summary.cache.partialValidSources}`);
  console.log(`  Missing sources:               ${summary.cache.missingSources}`);
  console.log(`  Invalid sources:               ${summary.cache.invalidSources}`);
  console.log(`  Candidate occurrences:         ${summary.cache.candidateOccurrences}`);
  console.log(`  Distinct Spotify tracks:       ${summary.cache.distinctSpotifyTracks}`);
  console.log(`  Unavailable tracks observed:   ${summary.cache.unavailableTrackCount}`);
  console.log("\nCanonical coverage:");
  console.log(`  TrackProviderRef:              ${summary.canonical.trackProviderRefs}`);
  console.log(`  Covered persisted tracks:      ${summary.coverage.coveredDistinctTracks}`);
  console.log(`  Missing canonical tracks:      ${summary.coverage.missingCanonicalDistinctTracks}`);
  console.log(`  Canonical outside cache:       ${summary.coverage.canonicalOutsidePersistedCache}`);
  console.log(`  Coverage bp:                   ${summary.coverage.basisPoints ?? "N/A"}`);
  console.log("\nGap classification:");
  console.log(`  Existing Gate 2B evidence:     ${summary.gaps.backfillEligibleTracks}`);
  console.log(`  Cache-only bootstrap-ready:    ${summary.gaps.cacheOnlyBootstrapReadyTracks}`);
  console.log(`  Incomplete artist metadata:    ${summary.gaps.incompleteArtistMetadataTracks}`);
  console.log("\nREAD_ONLY: no provider calls, no database writes, no planner/cache mutation.");
}

function parseArgs(argv: string[]): { userId: string; json: boolean } {
  let userId = "";
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
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--write") {
      throw new Error("Gate 2C is strictly read-only; --write is unsupported");
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!userId) {
    throw new Error("--user=<Sonoriza user id> is required; all-user audit is intentionally unsupported");
  }

  return { userId, json };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
