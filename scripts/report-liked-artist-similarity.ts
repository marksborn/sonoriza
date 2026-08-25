import { prisma } from "@/lib/prisma";
import {
  LIKED_ARTIST_SIMILARITY_POLICY,
  syncLikedArtistSimilarity,
} from "@/services/music-preference/liked-artist-similarity";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function intArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} deve ser inteiro`);
  return value;
}

async function main() {
  const email = argValue("email");
  if (!email) {
    throw new Error(
      "Uso: npm run liked:similarity -- --email=usuario@exemplo.com [--budget=20] [--per-seed=10] [--apply] [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const report = await syncLikedArtistSimilarity(user.id, {
    mode: hasArg("apply") ? "APPLY" : "PREVIEW",
    sourceBudget: intArg("budget", LIKED_ARTIST_SIMILARITY_POLICY.sourceBudget),
    perSeed: intArg("per-seed", LIKED_ARTIST_SIMILARITY_POLICY.perSeed),
    providerDelayMs: intArg("delay-ms", LIKED_ARTIST_SIMILARITY_POLICY.providerDelayMs),
  });

  if (hasArg("json")) {
    console.log(JSON.stringify({ user: user.email, ...report }, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(38)}${String(value)}`);

  console.log("========== LIKED-01 — GATE 3 SIMILARITY SHADOW ==========");
  p("User:", user.email);
  p("Mode:", report.mode);
  p("Provider:", report.provider);
  p("Generated at:", report.generatedAt.toISOString());
  p("Planner influence:", report.plannerInfluence);
  p("Spotify writes:", report.spotifyWrites);
  console.log();

  console.log("Policy:");
  p("  source budget:", report.policy.sourceBudget);
  p("  similar artists per seed:", report.policy.perSeed);
  p("  cache refresh:", `${report.policy.refreshDays} days`);
  p("  failure cooldown:", `${report.policy.failureCooldownHours} hours`);
  p("  provider delay:", `${report.policy.providerDelayMs} ms`);
  console.log();

  console.log("Explicit artist affinity:");
  p("  active artists:", report.affinity.activeArtists);
  p("  without artist name:", report.affinity.withoutName);
  console.log();

  console.log("Similarity cache:");
  p("  fresh sources:", report.cache.freshSources);
  p("  stale sources:", report.cache.staleSources);
  p("  unfetched sources:", report.cache.unfetchedSources);
  p("  reactivated sources:", report.cache.reactivatedSources);
  console.log();

  console.log("Provider acquisition:");
  p("  selected sources:", report.acquisition.selectedSources);
  p("  provider calls:", report.acquisition.providerCalls);
  p("  successful sources:", report.acquisition.successfulSources);
  p("  failed sources:", report.acquisition.failedSources);
  p("  candidate rows:", report.acquisition.rawCandidateRows);
  p("  distinct candidates in batch:", report.acquisition.distinctCandidatesInBatch);
  p("  already explicit affinity:", report.acquisition.directAffinityOverlapInBatch);
  console.log();

  console.log("Before:");
  p("  active seed caches:", report.before.activeSeeds);
  p("  active similarity edges:", report.before.activeEdges);
  p("  distinct candidates:", report.before.distinctCandidates);
  console.log();

  console.log("Planned reconciliation:");
  p("  seed states to create:", report.planned.seedStatesToCreate);
  p("  seed states to reactivate:", report.planned.seedStatesToReactivate);
  p("  seed states to refresh:", report.planned.seedStatesToRefresh);
  p("  seed states to deactivate:", report.planned.seedStatesToDeactivate);
  p("  seed metadata updates:", report.planned.seedMetadataUpdates);
  p("  failed seed updates:", report.planned.failedSeedUpdates);
  p("  edges to create:", report.planned.edgesToCreate);
  p("  edges to reactivate:", report.planned.edgesToReactivate);
  p("  edges to update:", report.planned.edgesToUpdate);
  p("  edges to deactivate:", report.planned.edgesToDeactivate);
  console.log();

  console.log("After:");
  p("  active seed caches:", report.after.activeSeeds);
  p("  active similarity edges:", report.after.activeEdges);
  p("  distinct candidates:", report.after.distinctCandidates);
  console.log();

  if (report.topCandidates.length > 0) {
    console.log("Top candidates in this batch:");
    for (const [index, row] of report.topCandidates.slice(0, 10).entries()) {
      console.log(
        `  ${String(index + 1).padStart(2)}. ${row.artistName} | similarity=${row.maxSimilarity.toFixed(3)} | seeds=${row.supportingSeeds} | direct=${row.directAffinity}`,
      );
    }
    console.log();
  }

  if (report.failures.length > 0) {
    console.log("Provider failures:");
    for (const failure of report.failures) {
      console.log(`  - ${failure.sourceArtistName}: ${failure.error}`);
    }
    console.log();
  }

  if (report.mode === "PREVIEW") {
    console.log(
      "PREVIEW only: nenhuma aresta/cache foi persistido. Nenhum efeito em planner/discovery e nenhuma escrita no Spotify.",
    );
  } else {
    console.log(
      "APPLY concluído em shadow mode: cache/arestas persistidos, sem influência no planner/discovery e sem escrita no Spotify.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
