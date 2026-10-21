import assert from "node:assert/strict";
import test from "node:test";

import {
  processMemoryCheckpoint,
  processMemorySnapshot,
} from "./process-memory";

const MIB = 1024 * 1024;

const sampleUsage: NodeJS.MemoryUsage = {
  rss: 645 * MIB,
  heapUsed: 232 * MIB,
  heapTotal: 280 * MIB,
  external: 11 * MIB,
  arrayBuffers: 4 * MIB,
};

test("memory telemetry rounds MiB from the supplied process usage", () => {
  assert.deepEqual(processMemorySnapshot(sampleUsage), {
    rssMb: 645,
    heapUsedMb: 232,
    heapTotalMb: 280,
    externalMb: 11,
  });
});

test("Gate 8 checkpoint contains only phase, timestamp and memory numbers", () => {
  const checkpoint = processMemoryCheckpoint(
    "RESERVE_GATE8_BEFORE_REAL_RUN",
    sampleUsage,
    new Date("2026-10-20T09:11:01.000Z"),
  );

  assert.deepEqual(checkpoint, {
    checkpoint: "RESERVE_GATE8_BEFORE_REAL_RUN",
    observedAt: "2026-10-20T09:11:01.000Z",
    memory: {
      rssMb: 645,
      heapUsedMb: 232,
      heapTotalMb: 280,
      externalMb: 11,
    },
  });
  assert.deepEqual(Object.keys(checkpoint), [
    "checkpoint",
    "observedAt",
    "memory",
  ]);
});
