#!/usr/bin/env node
/**
 * B1.6 — READ-ONLY operational GO/NO-GO, usable after the B1.3 migration
 * on a reviewed release checkout. No rows/IDs/names/secrets are printed.
 *
 * Usage:
 *   node --env-file=.env scripts/check-playback-reserve-operational-readiness.mjs --check
 */
import { pathToFileURL } from "node:url";

export function evaluateOperationalReadiness(input) {
  const measures = [
    "generationRunsRunning",
    "generationRunsPending",
    "targetScheduleRunsRunning",
    "targetScheduleAttemptsRunning",
    "productOptInsEnabled",
    "productOptInsWithoutConfirmation",
    "enabledTargets",
    "totalTargets",
  ];
  const blockers = [];
  for (const field of measures) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 0) {
      blockers.push(`${field}: invalid result`);
    }
  }
  if (blockers.length === 0) {
    if (input.generationRunsRunning || input.generationRunsPending ||
        input.targetScheduleRunsRunning || input.targetScheduleAttemptsRunning) {
      blockers.push("Generations or scheduled attempts are currently pending/running");
    }
    if (input.productOptInsEnabled || input.productOptInsWithoutConfirmation) {
      blockers.push("New product Reserve authorizations already exist; dormant-first baseline is not clean");
    }
    if (input.enabledTargets > input.totalTargets) {
      blockers.push("Enabled destination count exceeds total");
    }
  }
  return {
    stage: "POST_MIGRATION_DORMANT_GO_NO_GO",
    ready: blockers.length === 0,
    counts: Object.fromEntries(measures.map(k => [k, input[k] ?? null])),
    blockers,
  };
}

export async function readOperationalCounts(prisma) {
  // Every query is a read. Counts only; no target names, user emails,
  // Spotify URIs, credentials, identifiers or logs.
  const [
    generationRunsRunning,
    generationRunsPending,
    targetScheduleRunsRunning,
    targetScheduleAttemptsRunning,
    productOptInsEnabled,
    productOptInsWithoutConfirmation,
    enabledTargets,
    totalTargets,
  ] = await Promise.all([
    prisma.generationRun.count({ where: { status: "RUNNING" } }),
    prisma.generationRun.count({ where: { status: "PENDING" } }),
    prisma.targetScheduleRun.count({ where: { status: "RUNNING" } }),
    prisma.targetScheduleAttempt.count({ where: { status: "RUNNING" } }),
    prisma.targetPlaybackReserveActivation.count({ where: { enabled: true } }),
    prisma.targetPlaybackReserveActivation.count({
      where: { enabled: true, confirmedAt: null },
    }),
    prisma.targetPlaylist.count({ where: { enabled: true } }),
    prisma.targetPlaylist.count(),
  ]);
  return {
    generationRunsRunning, generationRunsPending, targetScheduleRunsRunning,
    targetScheduleAttemptsRunning, productOptInsEnabled,
    productOptInsWithoutConfirmation, enabledTargets, totalTargets,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--check") {
    process.stderr.write("Usage: ...operational-readiness.mjs --check\n");
    process.exitCode = 2;
  } else {
    let prisma;
    try {
      const { PrismaClient } = await import("@prisma/client");
      prisma = new PrismaClient();
      const counts = await readOperationalCounts(prisma);
      const outcome = evaluateOperationalReadiness(counts);
      process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
      if (!outcome.ready) process.exitCode = 2;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "QUERY_FAILED";
      process.stderr.write(`B1.6 operational check BLOCKED: database/schema read failed (${code}). No deploy authorization.\n`);
      process.exitCode = 2;
    } finally {
      await prisma?.$disconnect().catch(() => undefined);
    }
  }
}
