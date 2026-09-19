import { prisma } from "@/lib/prisma";
import { runMusicIdentityCacheShadowBootstrap } from "@/services/music-identity/cache-shadow-bootstrap";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runMusicIdentityCacheShadowBootstrap({
    userId: args.userId,
    write: args.write,
  });

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("========== MUSIC-IDENTITY-01 — GATE 2D CACHE SHADOW BOOTSTRAP ==========");
  console.log(`Mode:                              ${summary.mode}`);
  console.log(`User:                              ${summary.userId}`);
  console.log(`Provider calls:                    ${summary.authority.providerCalls}`);
  console.log(`Planner influence:                 ${summary.authority.plannerInfluence}`);
  console.log(`Cache mutation:                    ${summary.authority.cacheMutation}`);
  console.log("\nSnapshot:");
  console.log(`  Full valid sources:              ${summary.cache.fullValidSources}`);
  console.log(`  Partial valid sources:           ${summary.cache.partialValidSources}`);
  console.log(`  Missing sources:                 ${summary.cache.missingSources}`);
  console.log(`  Invalid sources:                 ${summary.cache.invalidSources}`);
  console.log(`  Missing cache timestamps:        ${summary.cache.missingCacheTimestampSources}`);
  console.log(`  Distinct Spotify tracks:         ${summary.cache.distinctSpotifyTracks}`);
  console.log("\nSelection:");
  console.log(`  Already canonical operational:   ${summary.selection.alreadyCanonicalOperationalTracks}`);
  console.log(`  Excluded Gate 2B eligible:       ${summary.selection.excludedBackfillEligibleTracks}`);
  console.log(`  Cache-only candidates:           ${summary.selection.candidateTracks}`);
  console.log(`  Incomplete:                      ${summary.selection.skippedIncompleteTracks}`);
  console.log(`  Conflicts:                       ${summary.selection.skippedConflictTracks}`);
  console.log(`  Snapshot write allowed:          ${summary.selection.snapshotWriteAllowed}`);
  console.log(`  Abstention reason:               ${summary.selection.abstentionReason ?? "NONE"}`);
  console.log("\nPersistence plan:");
  console.log(`  Track refs to create:            ${summary.planned.trackProviderRefsToCreate}`);
  console.log(`  Artist refs reused:              ${summary.planned.artistProviderRefsReused}`);
  console.log(`  Artist refs to create:           ${summary.planned.artistProviderRefsToCreate}`);
  console.log(`  Album release refs reused:       ${summary.planned.albumReleaseProviderRefsReused}`);
  console.log(`  Album release refs to create:    ${summary.planned.albumReleaseProviderRefsToCreate}`);
  console.log("\nProjected coverage:");
  console.log(`  Covered operational tracks:      ${summary.projectedCoverage.coveredOperationalTracksAfterWrite}`);
  console.log(`  Coverage bp:                     ${summary.projectedCoverage.basisPointsAfterWrite ?? "N/A"}`);
  console.log(
    args.write
      ? "\nWRITE completed. Canonical refs remain shadow-only and KNOWN."
      : "\nDRY_RUN: no database rows were created.",
  );
}

function parseArgs(argv: string[]): { userId: string; write: boolean; json: boolean } {
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
    throw new Error("--user=<Sonoriza user id> is required; all-user bootstrap is intentionally unsupported");
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
