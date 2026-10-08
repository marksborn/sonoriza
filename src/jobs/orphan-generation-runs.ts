import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// #435: GenerationRuns whose process died (or whose promise never returned
// before Gate 3C/3E existed) stay RUNNING forever. The scheduler now fences and
// terminalizes the runs it owns, but historical rows and runs without a
// scheduler attempt (MANUAL/SIMULATION) are only closed by this sweep.
export const DEFAULT_ORPHAN_MIN_AGE_MS = 2 * 60 * 60 * 1000;

export const ORPHAN_TERMINALIZED_REASON =
  "GenerationRun encerrado por varredura de órfãos (#435): permaneceu RUNNING " +
  "sem tentativa ativa do scheduler além do limite de idade. " +
  "Nenhuma alteração no Spotify foi feita por esta varredura.";

export type OrphanGenerationRun = {
  id: string;
  trigger: string;
  simulation: boolean;
  startedAt: Date;
  lastCheckpoint: string | null;
};

/**
 * Lists RUNNING GenerationRuns older than `minAgeMs` that are not linked to a
 * RUNNING scheduler attempt. A run still owned by a live attempt is left for
 * the scheduler's own stale/restart recovery, which keeps write fencing intact.
 */
export async function findOrphanGenerationRuns(
  now: Date,
  minAgeMs = DEFAULT_ORPHAN_MIN_AGE_MS,
): Promise<OrphanGenerationRun[]> {
  const cutoff = new Date(now.getTime() - minAgeMs);
  const runs = await prisma.generationRun.findMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: cutoff },
      scheduleAttempts: { none: { status: "RUNNING" } },
    },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      trigger: true,
      simulation: true,
      startedAt: true,
      logs: {
        where: { message: { startsWith: "Checkpoint " } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { data: true },
      },
    },
  });

  return runs.map((run) => ({
    id: run.id,
    trigger: run.trigger,
    simulation: run.simulation,
    startedAt: run.startedAt,
    lastCheckpoint: checkpointName(run.logs[0]?.data),
  }));
}

/**
 * Terminalizes the given orphans as FAILED. Idempotent and fenced on
 * `status=RUNNING`, so a run that finishes concurrently keeps its own result.
 * Returns the ids actually terminalized.
 */
export async function terminalizeOrphanGenerationRuns(
  orphans: OrphanGenerationRun[],
  now: Date,
): Promise<string[]> {
  const terminalized: string[] = [];
  for (const orphan of orphans) {
    const done = await prisma.$transaction(async (tx) => {
      const updated = await tx.generationRun.updateMany({
        where: { id: orphan.id, status: "RUNNING" },
        data: {
          status: "FAILED",
          finishedAt: now,
          error: ORPHAN_TERMINALIZED_REASON,
        },
      });
      if (updated.count !== 1) return false;

      await tx.generationLog.create({
        data: {
          runId: orphan.id,
          level: "WARN",
          message: "Checkpoint ORPHAN_TERMINALIZED",
          data: {
            checkpoint: "ORPHAN_TERMINALIZED",
            lastCheckpoint: orphan.lastCheckpoint,
            startedAt: orphan.startedAt.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
      return true;
    });
    if (done) terminalized.push(orphan.id);
  }
  return terminalized;
}

function checkpointName(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>).checkpoint;
  return typeof value === "string" ? value : null;
}
