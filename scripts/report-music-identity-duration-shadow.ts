import { prisma } from "@/lib/prisma";
import { runMusicIdentityDurationEvidenceShadow } from "@/services/music-identity/duration-evidence-shadow";

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
      "Gate 3C is SHADOW_DURATION_EVIDENCE_READ_ONLY; --write is not supported.",
    );
  }

  const userId = argValue("user");
  if (!userId) {
    throw new Error(
      "Uso: npx tsx scripts/report-music-identity-duration-shadow.ts --user=<id> [--json]",
    );
  }

  const report = await runMusicIdentityDurationEvidenceShadow(userId);

  if (hasArg("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(52)}${String(value)}`);

  console.log("======= MUSIC-IDENTITY-01 — GATE 3C DURATION SHADOW =======");
  p("User:", report.userId);
  p("Mode:", report.mode);

  if (report.mode === "SHADOW_DURATION_EVIDENCE_ABSTAINED") {
    p("Provider calls:", report.authority.providerCalls);
    p("Abstention:", report.abstentionReason);
    p("Baseline pairs:", report.baseline.pairCount);
    p("Reconstructed textual pairs:", report.baseline.reconstructedTextualPairs);
    return;
  }

  p("Provider calls:", report.authority.providerCalls);
  p("Canonical writes:", report.authority.canonicalWrites);
  p("Endpoint:", report.authority.endpoint);
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
  p("  Tracks with duration:", report.provider.tracksWithDuration);
  p("  Tracks missing duration:", report.provider.tracksMissingDuration);
  p("  Null tracks:", report.provider.nullTracks);
  console.log();

  console.log("Duration diagnostics (same-ISRC pairs only):");
  p("  Same ISRC pairs:", report.diagnostics.sameIsrcPairs);
  p("  Persisted duration complete:", report.diagnostics.persistedDurationCompletePairs);
  p("  Persisted duration missing:", report.diagnostics.persistedDurationMissingPairs);
  p("  Provider duration complete:", report.diagnostics.providerDurationCompletePairs);
  p("  Provider duration missing:", report.diagnostics.providerDurationMissingPairs);
  p("  Provider strong conflicts:", report.diagnostics.providerStrongConflictPairs);
  p("  Provider compatible:", report.diagnostics.providerCompatiblePairs);
  p(
    "  Persisted missing + provider compatible:",
    report.diagnostics.persistedMissingButProviderCompatiblePairs,
  );
  p(
    "  Persisted missing + provider conflict:",
    report.diagnostics.persistedMissingAndProviderConflictPairs,
  );
  p(
    "  Persisted complete + provider conflict:",
    report.diagnostics.persistedCompleteButProviderConflictPairs,
  );
  console.log();

  console.log(
    "Gate 3C is diagnostic only. Provider duration is compared against persisted duration evidence; no identity is merged, no cache is rewritten, and no consumer is activated.",
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
