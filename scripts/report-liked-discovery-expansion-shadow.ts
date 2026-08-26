import { prisma } from "@/lib/prisma";
import { getLikedDiscoveryExpansionShadowReport } from "@/services/music-preference/liked-discovery-expansion-shadow";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main() {
  const email = argValue("email");
  if (!email) {
    throw new Error(
      "Uso: npm run liked:expand-shadow -- --email=usuario@exemplo.com [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const report = await getLikedDiscoveryExpansionShadowReport(user.id);
  if (hasArg("json")) {
    console.log(JSON.stringify({ user: user.email ?? user.id, ...report }, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(42)}${String(value)}`);

  console.log("========== LIKED-01 — GATE 6A EXPANSION SHADOW ==========");
  p("User:", user.email ?? user.id);
  p("Generated at:", report.generatedAt.toISOString());
  p("Shadow only:", report.safety.shadowOnly);
  p("Planner influence:", report.safety.plannerInfluence);
  p("Database writes:", report.safety.databaseWrites);
  p("Spotify writes:", report.safety.spotifyWrites);
  p("Expansion Last.fm calls:", report.safety.expansionLastFmCalls);
  console.log();

  console.log("Policy:");
  p("  baseline pool:", report.policy.poolPerCategory);
  p("  compared top:", report.policy.topPerCategory);
  p("  history probes:", report.policy.historyProbeLimit);
  p("  resolution budget:", report.policy.resolutionCandidateBudget);
  p("  target resolved:", report.policy.targetResolvedCandidates);
  p("  max per dominant seed:", report.policy.maxPerDominantSeed);
  p("  source confidence:", report.policy.sourceConfidence);
  console.log();

  console.log("Baseline / current LIKED overlay:");
  p("  external status:", report.baseline.externalStatus);
  p("  baseline provider failures:", report.baseline.providerFailures);
  p("  discovery pool size:", report.baseline.discoveryPoolSize);
  printTop("  baseline top", report.baseline.top);
  printTop("  LIKED overlay top", report.likedOverlay.top);
  console.log();

  console.log("Persisted graph -> expansion funnel:");
  p("  direct affinity artists:", report.graph.directAffinityArtists);
  p("  active similarity seeds:", report.graph.activeSeedArtists);
  p("  active similarity edges:", report.graph.activeSimilarityEdges);
  p("  aggregate artist names:", report.graph.aggregateArtistNames);
  p("  ambiguous similar names:", report.graph.ambiguousSimilarityArtistNames);
  p("  excluded direct artists:", report.graph.excludedDirectArtistNames);
  p("  excluded represented artists:", report.graph.excludedAlreadyRepresentedArtistNames);
  p("  history probed artists:", report.graph.historyProbedArtistNames);
  p("  rejected known history:", report.graph.rejectedKnownHistoryArtistNames);
  p("  eligible resolution candidates:", report.graph.eligibleResolutionCandidates);
  p("  selected resolution candidates:", report.graph.selectedResolutionCandidates);
  console.log();

  console.log("Spotify read-only resolution:");
  p("  attempted:", report.resolution.attempted);
  p("  resolved:", report.resolution.resolved);
  p("  ambiguous:", report.resolution.ambiguous);
  p("  not found:", report.resolution.notFound);
  p("  provider failures:", report.resolution.failures.length);
  p("  Spotify catalog calls:", report.resolution.spotifyCatalogCalls);
  p("  Spotify failures:", report.resolution.spotifyFailures);
  p("  Spotify rate limits:", report.resolution.spotifyRateLimits);
  p("  Spotify retries:", report.resolution.spotifyRetries);
  console.log();

  if (report.resolvedCandidates.length > 0) {
    console.log("Resolved exploratory candidates:");
    report.resolvedCandidates.forEach((row, index) => {
      console.log(
        `  ${index + 1}. ${row.artistName} — ${row.trackName} | score=${row.scoreCard.score.toFixed(3)} | similarity=${row.maxSimilarity.toFixed(3)} | seeds=${row.supportingSeeds} | via=${row.seedArtistNames.slice(0, 5).join(", ")}`,
      );
    });
    console.log();
  }

  console.log("Expanded shadow top:");
  report.expandedTop.forEach((row, index) => {
    console.log(
      `  ${index + 1}. ${row.artistName} — ${row.trackName} | score=${row.displayScore.toFixed(3)} | source=${row.source} | signal=${row.signalKind}`,
    );
    if (row.explanation) console.log(`     ${row.explanation}`);
  });
  console.log();

  p(
    "Entrants vs baseline:",
    report.changes.entrantsVsBaseline.length > 0
      ? report.changes.entrantsVsBaseline
          .map((row) => `${row.artistName} — ${row.trackName}`)
          .join("; ")
      : "none",
  );
  p(
    "Exits vs baseline:",
    report.changes.exitsVsBaseline.length > 0
      ? report.changes.exitsVsBaseline
          .map((row) => `${row.artistName} — ${row.trackName}`)
          .join("; ")
      : "none",
  );
  p(
    "Entrants vs LIKED overlay:",
    report.changes.entrantsVsLikedOverlay.length > 0
      ? report.changes.entrantsVsLikedOverlay
          .map((row) => `${row.artistName} — ${row.trackName}`)
          .join("; ")
      : "none",
  );

  console.log();
  console.log(
    "Gate 6A é somente shadow: o grafo LIKED foi lido, artistas novos foram resolvidos via catálogo Spotify em leitura, mas nenhum candidato foi persistido, nenhum score do planner foi alterado e nenhuma playlist foi escrita.",
  );
}

function printTop(
  label: string,
  rows: Array<{
    artistName: string;
    trackName: string;
    shadowScore?: number;
    score?: number;
    signalKind?: string;
  }>,
) {
  console.log(`${label}:`);
  if (rows.length === 0) {
    console.log("    none");
    return;
  }
  rows.forEach((row, index) => {
    const score = row.shadowScore ?? row.score ?? 0;
    console.log(
      `    ${index + 1}. ${row.artistName} — ${row.trackName} | score=${score.toFixed(3)}${row.signalKind ? ` | ${row.signalKind}` : ""}`,
    );
  });
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
