import { prisma } from "@/lib/prisma";
import { runMusicIdentityStrongIdentifierShadow } from "@/services/music-identity/strong-identifier-enrichment-shadow";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main() {
  if (hasArg("write")) {
    throw new Error(
      "Gate 3B is SHADOW_PROVIDER_ENRICHMENT_READ_ONLY; --write is not supported.",
    );
  }

  const userId = argValue("user");
  if (!userId) {
    throw new Error(
      "Uso: npx tsx scripts/report-music-identity-strong-id-shadow.ts --user=<id> [--json]",
    );
  }

  const report = await runMusicIdentityStrongIdentifierShadow(userId);

  if (hasArg("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(46)}${String(value)}`);

  console.log("======= MUSIC-IDENTITY-01 — GATE 3B SHADOW =======");
  p("User:", report.userId);
  p("Mode:", report.mode);

  if (report.mode === "SHADOW_PROVIDER_ENRICHMENT_ABSTAINED") {
    p("Provider calls:", report.authority.providerCalls);
    p("Abstention:", report.abstentionReason);
    p("Baseline pairs:", report.baseline.pairCount);
    p("Reconstructed textual pairs:", report.baseline.reconstructedTextualPairs);
    return;
  }

  p("Provider calls:", report.authority.providerCalls);
  p("Identity writes:", report.authority.identityWrites);
  p("Endpoint:", report.authority.endpoint);
  p("Endpoint deprecated:", report.authority.endpointDeprecated);
  console.log();

  console.log("Baseline:");
  p("  Pair count:", report.baseline.pairCount);
  p("  Textual possible:", report.baseline.textualPossibleMatchPairs);
  p("  Same song / different recording:", report.baseline.sameSongDifferentRecordingPairs);
  p("  Reconstructed textual pairs:", report.baseline.reconstructedTextualPairs);
  console.log();

  console.log("Provider evidence:");
  p("  Requested distinct tracks:", report.provider.requestedDistinctTracks);
  p("  Returned tracks:", report.provider.returnedTracks);
  p("  Tracks with ISRC:", report.provider.tracksWithIsrc);
  p("  Tracks missing ISRC:", report.provider.tracksMissingIsrc);
  p("  Relinked tracks:", report.provider.relinkedTracks);
  p("  Null tracks:", report.provider.nullTracks);
  console.log();

  console.log("Resolution:");
  p("  Pair count:", report.resolution.pairCount);
  p("  Same ISRC:", report.resolution.sameIsrcPairs);
  p("  Different ISRC:", report.resolution.differentIsrcPairs);
  p("  Missing ISRC:", report.resolution.missingIsrcPairs);
  p("  Upgrade to recording review:", report.resolution.upgradedToRecordingReviewPairs);
  p("  Keep recordings separate:", report.resolution.keptSeparatePairs);
  p("  Strong-ID conflicts:", report.resolution.strongIdConflictPairs);
  p("  Different-ISRC review only:", report.resolution.reviewOnlyDifferentIsrcPairs);
  p("  Insufficient strong ID:", report.resolution.insufficientStrongIdPairs);
  console.log();

  console.log(
    "Gate 3B is diagnostic only. ISRC can promote a pair to REVIEW_RECORDING_MERGE, but no canonical identity is mutated and no consumer is activated.",
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
