import { prisma } from "@/lib/prisma";
import { runMusicIdentityCanonicalPreferenceShadow } from "@/services/music-identity/canonical-preference-shadow";

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
      "Gate 4A is SHADOW_CANONICAL_DEDUPE_PREFERENCE_READ_ONLY; --write is not supported.",
    );
  }

  const userId = argValue("user");
  if (!userId) {
    throw new Error(
      "Uso: npx tsx scripts/report-music-identity-canonical-preference-shadow.ts --user=<id> [--json]",
    );
  }

  const report = await runMusicIdentityCanonicalPreferenceShadow(userId);

  if (hasArg("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(52)}${String(value)}`);

  console.log("======= MUSIC-IDENTITY-01 — GATE 4A DEDUPE/PREFERENCE SHADOW =======");
  p("User:", report.userId);
  p("Mode:", report.mode);

  if (report.mode === "SHADOW_CANONICAL_DEDUPE_PREFERENCE_ABSTAINED") {
    p("Provider calls:", report.authority.providerCalls);
    p("Abstention:", report.abstentionReason);
    p("Baseline pairs:", report.baseline.pairCount);
    p("Reconstructed textual pairs:", report.baseline.reconstructedTextualPairs);
    return;
  }

  p("Provider calls:", report.authority.providerCalls);
  p("Canonical writes:", report.authority.canonicalWrites);
  p("Preference writes:", report.authority.preferenceWrites);
  p("Planner influence:", report.authority.plannerInfluence);
  p("LikedTrackPreference read:", report.authority.likedTrackPreferenceRead);
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
  p("  Null tracks:", report.provider.nullTracks);
  console.log();

  console.log("Native TRACK preferences:");
  p("  Loaded:", report.preferences.loadedTrackPreferences);
  p("  Matched to candidate universe:", report.preferences.matchedTrackPreferences);
  p("  Unmatched:", report.preferences.unmatchedTrackPreferences);
  console.log();

  console.log("Canonical/preference comparison:");
  p("  Pairs:", report.comparison.pairCount);
  p("  Canonical recording candidates:", report.comparison.canonicalRecordingCandidatePairs);
  p("  Identity blocked:", report.comparison.identityBlockedPairs);
  p("  Preference safe:", report.comparison.preferenceSafePairs);
  p("  Preference conflicts:", report.comparison.preferenceConflictPairs);
  p("  No explicit TRACK preference:", report.comparison.noPreferencePairs);
  p("  Identical explicit preference:", report.comparison.identicalPreferencePairs);
  p("  Presence conflicts:", report.comparison.presenceConflictPairs);
  p("  Policy conflicts:", report.comparison.policyConflictPairs);
  p("  Source/provenance conflicts:", report.comparison.sourceConflictPairs);
  p("  EXCLUDED conflicts:", report.comparison.excludedConflictPairs);
  console.log();

  console.log(
    "Gate 4A is comparison-only: it does not merge RecordingIdentity, does not propagate preference policy, does not choose a provider representative, and does not influence planner/playback.",
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
