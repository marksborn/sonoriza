import { prisma } from "@/lib/prisma";
import {
  LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY,
  runLikedArtistSimilarityBackfill,
  type LikedArtistSimilarityBackfillSnapshot,
} from "@/services/music-preference/liked-artist-similarity-backfill";

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
      "Uso: npm run liked:backfill -- --email=usuario@exemplo.com [--batch=100] [--max-batches=10] [--per-seed=10] [--delay-ms=250] [--batch-pause-ms=1000] [--apply] [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const report = await runLikedArtistSimilarityBackfill(user.id, {
    mode: hasArg("apply") ? "APPLY" : "PREVIEW",
    batchBudget: intArg("batch", LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.batchBudget),
    maxBatches: intArg(
      "max-batches",
      LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.maxBatches,
    ),
    perSeed: intArg("per-seed", LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.perSeed),
    providerDelayMs: intArg(
      "delay-ms",
      LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.providerDelayMs,
    ),
    batchPauseMs: intArg(
      "batch-pause-ms",
      LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.batchPauseMs,
    ),
  });

  if (hasArg("json")) {
    console.log(JSON.stringify({ user: user.email ?? user.id, ...report }, null, 2));
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(42)}${String(value)}`);

  console.log("========== LIKED-01 — GATE 5 PILOT BACKFILL ==========");
  p("User:", user.email ?? user.id);
  p("Mode:", report.mode);
  p("Status:", report.status);
  p("Generated at:", report.generatedAt.toISOString());
  p("Shadow only:", report.safety.shadowOnly);
  p("Planner influence:", report.safety.plannerInfluence);
  p("Spotify writes:", report.safety.spotifyWrites);
  p("Database writes:", report.safety.databaseWrites);
  console.log();

  console.log("Policy:");
  p("  batch budget:", report.policy.batchBudget);
  p("  max batches:", report.policy.maxBatches);
  p("  similar artists per seed:", report.policy.perSeed);
  p("  provider delay:", `${report.policy.providerDelayMs} ms`);
  p("  pause between batches:", `${report.policy.batchPauseMs} ms`);
  p(
    "  provider failure guard:",
    `>=${report.policy.providerFailureGuardMinFailures} failures and >=${Math.round(
      report.policy.providerFailureGuardRate * 100,
    )}% of batch, or 100% failure`,
  );
  console.log();

  printSnapshot("Before", report.before, p);

  console.log("Plan:");
  p("  pending sources:", report.plan.pendingSources);
  p("  ready sources now:", report.plan.readySourcesNow);
  p("  blocked by cooldown:", report.plan.blockedByCooldown);
  p("  estimated batches this run:", report.plan.estimatedBatchesThisRun);
  p("  estimated provider calls:", report.plan.estimatedProviderCallsThisRun);
  p("  max provider calls this run:", report.plan.maxProviderCallsThisRun);
  p("  can complete this run:", report.plan.canCompleteThisRun);
  console.log();

  if (report.batches.length > 0) {
    console.log("Executed batches:");
    for (const batch of report.batches) {
      p(
        `  batch ${batch.batch}:`,
        `budget=${batch.requestedBudget} selected=${batch.selectedSources} calls=${batch.providerCalls} success=${batch.successfulSources} failed=${batch.failedSources} failureRate=${(
          batch.failureRate * 100
        ).toFixed(1)}% seeds=${batch.beforeActiveSeeds}->${batch.afterActiveSeeds} edges=${batch.beforeActiveEdges}->${batch.afterActiveEdges}`,
      );
      for (const failure of batch.failures.slice(0, 5)) {
        console.log(`    - ${failure.sourceArtistName}: ${failure.error}`);
      }
      if (batch.failures.length > 5) {
        console.log(`    ... ${batch.failures.length - 5} falha(s) adicional(is)`);
      }
    }
    console.log();
  }

  printSnapshot("After", report.after, p);

  console.log("Totals:");
  p("  provider calls:", report.totals.providerCalls);
  p("  successful sources:", report.totals.successfulSources);
  p("  failed sources:", report.totals.failedSources);
  console.log();

  if (report.mode === "PREVIEW") {
    console.log(
      "PREVIEW only: zero chamadas ao provider e zero writes. Use --apply somente após revisar cobertura, custo e guards.",
    );
  } else if (report.status === "COMPLETE") {
    console.log(
      "APPLY concluiu o backfill piloto em shadow mode. Reexecutar deve ser idempotente: zero chamadas enquanto a cobertura continuar completa/fresca.",
    );
  } else {
    console.log(
      `APPLY interrompido com status ${report.status}. O estado persistido até aqui é retomável; não force refresh/loop manual sem revisar o motivo.`,
    );
  }
}

function printSnapshot(
  title: string,
  snapshot: LikedArtistSimilarityBackfillSnapshot,
  p: (label: string, value: unknown) => void,
) {
  console.log(`${title}:`);
  p("  active affinity artists:", snapshot.activeAffinityArtists);
  p("  queryable affinity artists:", snapshot.queryableAffinityArtists);
  p("  without artist name:", snapshot.withoutArtistName);
  p("  successful active seeds:", snapshot.successfulActiveSeeds);
  p("  coverage:", `${snapshot.coveragePct}%`);
  p("  pending sources:", snapshot.pendingSources);
  p("  priority ready sources:", snapshot.priorityReadySources);
  p("  retryable failed sources:", snapshot.retryableFailedSources);
  p("  cooldown blocked sources:", snapshot.cooldownBlockedSources);
  p("  stale successful sources:", snapshot.staleSuccessfulSources);
  p("  active seed rows:", snapshot.activeSeedRows);
  p("  active similarity edges:", snapshot.activeSimilarityEdges);
  p("  distinct candidates:", snapshot.distinctCandidates);
  p("  duplicate active seed rows:", snapshot.duplicateActiveSeedRows);
  p("  duplicate active edge rows:", snapshot.duplicateActiveEdgeRows);
  console.log();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
