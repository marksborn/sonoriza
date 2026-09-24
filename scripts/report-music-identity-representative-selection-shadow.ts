import { prisma } from "@/lib/prisma";
import { runMusicIdentityCanonicalRepresentativeSelectionShadow } from "@/services/music-identity/canonical-representative-selection-shadow";

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
      "Gate 4D is SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_READ_ONLY; --write is not supported.",
    );
  }

  const userId = argValue("user");
  if (!userId) {
    throw new Error(
      "Uso: npx tsx scripts/report-music-identity-representative-selection-shadow.ts --user=<id> [--json]",
    );
  }

  const report = await runMusicIdentityCanonicalRepresentativeSelectionShadow(userId);
  if (hasArg("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(58)}${String(value)}`);

  p("Gate", report.gate);
  p("Mode", report.mode);
  p("User", report.userId);
  p("Generated", report.generatedAt.toISOString());

  if (report.mode === "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_ABSTAINED") {
    p("Abstention", report.abstentionReason);
    p("Detail", report.detail ?? "-");
    p("Gate 4C mode", report.gate4cMode);
    p("Gate 4C fingerprint", report.gate4cSnapshotFingerprint ?? "-");
    return;
  }

  p("Policy", report.authority.representativePolicy);
  p("Consumer boundary", report.authority.consumerInputBasis);
  p("Source order authority", report.authority.sourceOrderAuthority);
  p("Cache order authority", report.authority.cacheOrderAuthority);
  p("Gate 4C collisions", report.selection.collisionsReceived);
  p("Selectable collisions", report.selection.collisionsSelectable);
  p("Abstained collisions", report.selection.collisionsAbstained);
  p("Hypothetical drops", report.selection.hypotheticalDrops);
  p("Gate 4C expected drops", report.selection.gate4cExpectedHypotheticalDrops);
  p("Reduction reconciled", report.selection.reductionReconciled);
  p("Distinct representatives", report.selection.distinctRepresentatives);
  p("Decided by source order", report.selection.selectionsDependingOnSourceOrder);
  p("Decided by cache position", report.selection.selectionsDependingOnCachePosition);
  p("Provider-ID tie-break", report.selection.selectionsUsingProviderIdTieBreak);
  p(
    "Representatives in multiple sources",
    report.selection.representativesAppearingInMultipleSources,
  );
  p("Identity writes", report.authority.identityWrites);
  p("Canonical writes", report.authority.canonicalWrites);
  p("Consumer activation", report.authority.consumerActivation);
  p("Planner influence", report.authority.plannerInfluence);
  p("Spotify playlist writes", report.authority.spotifyPlaylistWrites);
  p("ORDER_HASH influence", report.authority.orderHashInfluence);
  p(
    "Productive representative selection",
    report.authority.productiveRepresentativeSelection,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
