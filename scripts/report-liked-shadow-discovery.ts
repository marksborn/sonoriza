import { prisma } from "@/lib/prisma";
import {
  getLikedShadowDiscoveryComparison,
  LIKED_SHADOW_DISCOVERY_POLICY,
  type LikedShadowCategoryComparison,
} from "@/services/music-preference/liked-shadow-discovery";

type Args = {
  email: string;
  pool: number;
  top: number;
  json: boolean;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${args.email}`);

  const report = await getLikedShadowDiscoveryComparison(user.id, {
    poolPerCategory: args.pool,
    topPerCategory: args.top,
  });

  if (args.json) {
    console.log(JSON.stringify({ user: user.email ?? user.id, ...report }, null, 2));
    return;
  }

  console.log("========== LIKED-01 — GATE 4 SHADOW DISCOVERY ==========");
  line("User:", user.email ?? user.id);
  line("Generated at:", report.generatedAt.toISOString());
  line("Baseline generated at:", report.baseline.generatedAt.toISOString());
  line("Shadow only:", report.safety.shadowOnly);
  line("Planner influence:", report.safety.plannerInfluence);
  line("Database writes:", report.safety.databaseWrites);
  line("Spotify writes:", report.safety.spotifyWrites);
  line("LIKED provider calls:", report.safety.likedSignalProviderCalls);
  line("Baseline external status:", report.baseline.externalStatus.status);
  line("Baseline provider failures:", report.baseline.externalStatus.providerFailures);

  console.log("\nPolicy:");
  line("  pool per category:", report.policy.poolPerCategory);
  line("  compared top per category:", report.policy.topPerCategory);
  line("  max direct LIKE boost:", report.policy.directBoostMax);
  line("  max similar boost:", report.policy.similarBoostMax);
  line("  similar boost scope:", "DESCOBERTA only");
  line("  identity basis:", report.policy.identityBasis);

  console.log("\nLIKED signal coverage:");
  line("  active direct affinity artists:", report.coverage.activeDirectAffinityArtists);
  line("  cached similarity seed artists:", report.coverage.cachedSeedArtists);
  line("  cached seed coverage:", `${report.coverage.cachedSeedCoveragePct}%`);
  line("  active similarity edges:", report.coverage.activeSimilarityEdges);
  line(
    "  distinct cached candidates:",
    report.coverage.distinctCachedSimilarityCandidates,
  );
  line("  exploratory cached names:", report.coverage.exploratoryCachedArtistNames);
  line("  ambiguous direct names:", report.coverage.ambiguousDirectArtistNames);
  line("  ambiguous similar names:", report.coverage.ambiguousSimilarityArtistNames);

  printCategory(report.categories.familiar);
  printCategory(report.categories.rediscovery);
  printCategory(report.categories.discovery);

  console.log("\nLatent exploratory artists from persisted Gate 3 cache:");
  line("  count:", report.latentExploratoryArtists.count);
  console.log(`  ${report.latentExploratoryArtists.note}`);
  if (report.latentExploratoryArtists.top.length === 0) {
    console.log("  (none)");
  } else {
    report.latentExploratoryArtists.top.forEach((row, index) => {
      console.log(
        `  ${rank(index)} ${row.artistName} | similarity=${row.maxSimilarity.toFixed(3)} | seeds=${row.supportingSeeds} | via=${row.seedArtistNames.join(", ")}`,
      );
    });
  }

  console.log(
    "\nGate 4 é somente comparação: nenhum score do planner foi alterado, nenhuma recomendação foi persistida e nenhuma playlist foi escrita.",
  );
}

function printCategory(comparison: LikedShadowCategoryComparison) {
  console.log(`\n=== ${comparison.category} ===`);
  line("Pool size:", comparison.poolSize);
  line("Top overlap:", `${comparison.changes.overlapCount}/${comparison.baseline.length}`);
  line("Jaccard:", comparison.changes.jaccard.toFixed(3));
  line("Signal affected pool:", comparison.changes.signalAffectedPool);
  line("Signal affected shadow top:", comparison.changes.signalAffectedTop);

  console.log("Baseline top:");
  if (comparison.baseline.length === 0) console.log("  (none)");
  comparison.baseline.forEach((row, index) => {
    console.log(
      `  ${rank(index)} ${row.artistName} — ${row.trackName} | score=${row.baselineScore.toFixed(3)} | shadowRank=${row.shadowRank}`,
    );
  });

  console.log("Shadow top:");
  if (comparison.shadow.length === 0) console.log("  (none)");
  comparison.shadow.forEach((row, index) => {
    const signal = row.signalKind === "NONE" ? "no LIKED signal" : row.signalKind;
    console.log(
      `  ${rank(index)} ${row.artistName} — ${row.trackName} | ${row.baselineScore.toFixed(3)} + ${row.boost.toFixed(3)} = ${row.shadowScore.toFixed(3)} | baselineRank=${row.baselineRank} | ${signal}`,
    );
    if (row.explanation) console.log(`       ${row.explanation}`);
  });

  line(
    "Entrants:",
    comparison.changes.entrants.length === 0
      ? "none"
      : comparison.changes.entrants
          .map((row) => `${row.artistName} — ${row.trackName}`)
          .join(" | "),
  );
  line(
    "Exits:",
    comparison.changes.exits.length === 0
      ? "none"
      : comparison.changes.exits
          .map((row) => `${row.artistName} — ${row.trackName}`)
          .join(" | "),
  );
  line("Moved within top:", comparison.changes.moved.length);
  line(
    "Diversity baseline:",
    `${comparison.diversity.baseline.uniqueArtists} artists / ${comparison.diversity.baseline.slots} slots; maxArtistSlots=${comparison.diversity.baseline.maxSlotsFromOneArtist}`,
  );
  line(
    "Diversity shadow:",
    `${comparison.diversity.shadow.uniqueArtists} artists / ${comparison.diversity.shadow.slots} slots; maxArtistSlots=${comparison.diversity.shadow.maxSlotsFromOneArtist}; direct=${comparison.diversity.shadow.directAffinitySlots}; similar=${comparison.diversity.shadow.similarExploratorySlots}`,
  );
}

function parseArgs(argv: string[]): Args {
  let email = "";
  let pool = LIKED_SHADOW_DISCOVERY_POLICY.poolPerCategory;
  let top = LIKED_SHADOW_DISCOVERY_POLICY.topPerCategory;
  let json = false;

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      continue;
    }
    if (arg.startsWith("--pool=")) {
      pool = parseIntArg(arg.slice("--pool=".length), "pool", 12);
      continue;
    }
    if (arg.startsWith("--top=")) {
      top = parseIntArg(arg.slice("--top=".length), "top", 12);
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Argumento desconhecido: ${arg}`);
  }

  if (!email) {
    throw new Error(
      "Uso: npm run liked:shadow-discovery -- --email=usuario@exemplo.com [--pool=12] [--top=4] [--json]",
    );
  }
  if (top > pool) throw new Error("--top não pode ser maior que --pool");
  return { email, pool, top, json };
}

function parseIntArg(raw: string, name: string, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`--${name} deve ser inteiro entre 1 e ${max}`);
  }
  return value;
}

function line(label: string, value: unknown) {
  console.log(`${label.padEnd(38)}${String(value)}`);
}

function rank(index: number): string {
  return `${String(index + 1).padStart(2)}.`;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
