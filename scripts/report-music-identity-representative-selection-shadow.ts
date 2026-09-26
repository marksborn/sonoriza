process.env.PRISMA_TRANSACTION_TIMEOUT_MS ??= "30000";

const DEFAULT_PROVIDER_BUDGET = 25;
let disconnectPrisma: (() => Promise<void>) | null = null;

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function providerBudget(): number {
  const raw = argValue("provider-budget");
  if (raw === null) return DEFAULT_PROVIDER_BUDGET;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--provider-budget must be an integer between 0 and 100");
  }
  return parsed;
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
      "Uso: npx tsx scripts/report-music-identity-representative-selection-shadow.ts --user=<id> [--provider-budget=25] [--json]",
    );
  }

  const [
    { prisma },
    { runMusicIdentityCanonicalRepresentativeSelectionShadow },
    { runMusicIdentityCanonicalConsumerDedupeShadow },
    { SpotifyCatalogReadSession },
    { SpotifyCatalogSearchClient },
  ] = await Promise.all([
    import("@/lib/prisma"),
    import("@/services/music-identity/canonical-representative-selection-shadow"),
    import("@/services/music-identity/canonical-consumer-dedupe-shadow"),
    import("@/services/spotify/catalog-read-session"),
    import("@/services/spotify/catalog-search"),
  ]);
  disconnectPrisma = () => prisma.$disconnect();

  const budget = providerBudget();
  const readSession = new SpotifyCatalogReadSession(userId, {
    requestBudget: budget,
  });
  const provider = await SpotifyCatalogSearchClient.forUser(userId, {
    readSession,
  });

  const report = await runMusicIdentityCanonicalRepresentativeSelectionShadow(userId, {
    gate4cRunner: (requestedUserId) =>
      runMusicIdentityCanonicalConsumerDedupeShadow(requestedUserId, { provider }),
  });
  const providerReadSession = readSession.getMetrics();

  if (hasArg("json")) {
    console.log(JSON.stringify({ report, providerReadSession }, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(58)}${String(value)}`);

  p("Gate", report.gate);
  p("Mode", report.mode);
  p("User", report.userId);
  p("Generated", report.generatedAt.toISOString());
  p("Provider request budget", providerReadSession.requestBudget);
  p("Provider network requests", providerReadSession.networkRequests);
  p("Provider cache hits", providerReadSession.cacheHits);
  p("Provider cache misses", providerReadSession.cacheMisses);
  p("Provider cache writes", providerReadSession.cacheWrites);

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
    await disconnectPrisma?.();
  });
