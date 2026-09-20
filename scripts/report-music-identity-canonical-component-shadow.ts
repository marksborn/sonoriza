import { prisma } from "@/lib/prisma";
import { runMusicIdentityCanonicalComponentClosureShadow } from "@/services/music-identity/canonical-component-closure-shadow";

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
      "Gate 4B is SHADOW_CANONICAL_COMPONENT_CLOSURE_READ_ONLY; --write is not supported.",
    );
  }

  const userId = argValue("user");
  if (!userId) {
    throw new Error(
      "Uso: npx tsx scripts/report-music-identity-canonical-component-shadow.ts --user=<id> [--json]",
    );
  }

  const report = await runMusicIdentityCanonicalComponentClosureShadow(userId);

  if (hasArg("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(54)}${String(value)}`);

  console.log("======= MUSIC-IDENTITY-01 — GATE 4B COMPONENT CLOSURE SHADOW =======");
  p("User:", report.userId);
  p("Mode:", report.mode);

  if (report.mode === "SHADOW_CANONICAL_COMPONENT_CLOSURE_ABSTAINED") {
    p("Provider calls:", report.authority.providerCalls);
    p("Abstention:", report.abstentionReason);
    p("Baseline pairs:", report.baseline.pairCount);
    p("Reconstructed textual pairs:", report.baseline.reconstructedTextualPairs);
    return;
  }

  p("Provider calls:", report.authority.providerCalls);
  p("Canonical writes:", report.authority.canonicalWrites);
  p("Preference writes:", report.authority.preferenceWrites);
  p("Consumer activation:", report.authority.consumerActivation);
  p("Planner influence:", report.authority.plannerInfluence);
  p("Representative selection:", report.authority.representativeSelection);
  console.log();

  console.log("Pair universe:");
  p("  Pairs:", report.comparison.pairCount);
  p("  Canonical recording candidates:", report.comparison.canonicalRecordingCandidatePairs);
  p("  Identity blocked:", report.comparison.identityBlockedPairs);
  p("  Preference-safe candidates:", report.comparison.preferenceSafeCandidatePairs);
  p("  Preference-conflict candidates:", report.comparison.preferenceConflictCandidatePairs);
  console.log();

  console.log("Component closure:");
  p("  Components:", report.comparison.componentCount);
  p("  Safe components:", report.comparison.safeComponents);
  p("  Blocked components:", report.comparison.blockedComponents);
  p("  Transitive components (>2 members):", report.comparison.transitiveComponents);
  p("  Internal identity contradictions:", report.comparison.internalContradictionComponents);
  p("  Duration closure blockers:", report.comparison.durationBlockedComponents);
  p("  Preference blockers:", report.comparison.preferenceBlockedComponents);
  p("  Incomplete internal evidence:", report.comparison.incompleteEvidenceComponents);
  p("  Largest component size:", report.comparison.largestComponentSize);
  console.log();

  console.log("Hypothetical recording cardinality:");
  p(
    "  Legacy identities in candidate components:",
    report.comparison.legacyRecordingIdentitiesInCandidateComponents,
  );
  p(
    "  Hypothetical identities after safe closure:",
    report.comparison.hypotheticalRecordingIdentitiesAfter,
  );
  p("  Hypothetical reduction:", report.comparison.hypotheticalReduction);
  console.log();

  console.log(
    "Gate 4B is diagnostic only: no RecordingIdentity is merged, no preference is propagated, no representative is selected, and no consumer/planner behavior changes.",
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
