// #442: process memory sampled at each generation/scheduler checkpoint, so the
// stage that pushes the scheduled run past PM2's max_memory_restart is visible
// in the persisted audit trail instead of only in pm2.log.
export type ProcessMemorySnapshot = {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
};

const MB = 1024 * 1024;

export function processMemorySnapshot(
  usage: NodeJS.MemoryUsage = process.memoryUsage(),
): ProcessMemorySnapshot {
  return {
    rssMb: Math.round(usage.rss / MB),
    heapUsedMb: Math.round(usage.heapUsed / MB),
    heapTotalMb: Math.round(usage.heapTotal / MB),
    externalMb: Math.round(usage.external / MB),
  };
}

/**
 * #442 Gate 2: a small, privacy-safe memory sample for preflight phases.
 * It contains no playlist data, provider URLs, user IDs or runtime secrets.
 */
export type ProcessMemoryCheckpoint = {
  checkpoint: string;
  observedAt: string;
  memory: ProcessMemorySnapshot;
};

export function processMemoryCheckpoint(
  checkpoint: string,
  usage: NodeJS.MemoryUsage = process.memoryUsage(),
  observedAt: Date = new Date(),
): ProcessMemoryCheckpoint {
  return {
    checkpoint,
    observedAt: observedAt.toISOString(),
    memory: processMemorySnapshot(usage),
  };
}
