import { prisma } from "@/lib/prisma";
import { runMusicIdentityCanonicalConsumerDedupeShadow } from "@/services/music-identity/canonical-consumer-dedupe-shadow";

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
      "Gate 4C is SHADOW_CANONICAL_CONSUMER_DEDUPE_READ_ONLY; --write is not supported.",
    );
  }

  const userId = argValue("user");
  if (!userId) {
    throw new Error(
      "Uso: npx tsx scripts/report-music-identity-consumer-dedupe-shadow.ts --user=<id> [--json]",
    );
  }

  const report = await runMusicIdentityCanonicalConsumerDedupeShadow(userId);

  if (hasArg("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(54)}${String(value)}`);

  console.log("======= MUSIC-IDENTITY-01 — GATE 4C CONSUMER DEDUPE SHADOW =======");
  p("User:", report.userId);
  p("Mode:", report.mode);

  if (report.mode === "SHADOW_CANONICAL_CONSUMER_DEDUPE_ABSTAINED") {
    p("Provider evaluation attempted:", report.authority.providerEvaluationAttempted);
    p("Provider calls may have occurred:", report.authority.providerCallsMayHaveOccurred);
    p("Abstention:", report.abstentionReason);
    p("Detail:", report.detail ?? "-");
    p("Baseline pairs:", report.baseline.pairCount);
    p("Reconstructed textual pairs:", report.baseline.reconstructedTextualPairs);
    return;
  }

  p("Consumer input basis:", report.authority.consumerInputBasis);
  p("Legacy dedupe key:", report.authority.legacyDedupeKey);
  p("Provider calls:", report.authority.providerCalls);
  p("Canonical writes:", report.authority.canonicalWrites);
  p("Preference writes:", report.authority.preferenceWrites);
  p("Consumer activation:", report.authority.consumerActivation);
  p("Planner influence:", report.authority.plannerInfluence);
  p("ORDER_HASH influence:", report.authority.orderHashInfluence);
  p("Representative selection:", report.authority.representativeSelection);
  console.log();

  console.log("Gate 4B component authority:");
  p("  Components:", report.components.componentCount);
  p("  Safe components:", report.components.safeComponents);
  p("  Blocked components:", report.components.blockedComponents);
  p("  Safe member tracks:", report.components.safeMemberTracks);
  p(
    "  Safe components with explicit preference:",
    report.components.safeComponentsWithExplicitPreference,
  );
  console.log();

  console.log("Consumer input:");
  p("  Enabled targets:", report.legacyInput.enabledTargets);
  p("  Reachable MUSIC sources:", report.legacyInput.reachableMusicSources);
  p("  Candidate occurrences:", report.legacyInput.candidateOccurrences);
  p("  Distinct provider tracks:", report.legacyInput.distinctProviderTrackIds);
  p("  Distinct URIs:", report.legacyInput.distinctUris);
  console.log();

  console.log("Canonical collision comparison:");
  p("  Targets evaluated:", report.comparison.targetsEvaluated);
  p("  Targets with collision:", report.comparison.targetsWithCanonicalCollision);
  p("  Sources evaluated:", report.comparison.sourcesEvaluated);
  p("  Sources with collision:", report.comparison.sourcesWithCanonicalCollision);
  p("  Target/component collisions:", report.comparison.targetComponentCollisions);
  p(
    "  Distinct colliding components:",
    report.comparison.distinctCollidingComponentsAcrossTargets,
  );
  p("  Legacy target recording keys:", report.comparison.targetLegacyDistinctRecordingKeys);
  p(
    "  Hypothetical target recording keys:",
    report.comparison.targetHypotheticalCanonicalRecordingKeys,
  );
  p("  Hypothetical target reduction:", report.comparison.targetHypotheticalReduction);
  console.log();

  console.log(
    "Gate 4C is count/set comparison only: no provider track is selected as representative and no consumer/planner/playlist behavior changes.",
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
