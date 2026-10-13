import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOperationalReadiness, readOperationalCounts,
} from "./check-playback-reserve-operational-readiness.mjs";

const clear = {
  generationRunsRunning: 0,
  generationRunsPending: 0,
  targetScheduleRunsRunning: 0,
  targetScheduleAttemptsRunning: 0,
  productOptInsEnabled: 0,
  productOptInsWithoutConfirmation: 0,
  enabledTargets: 4,
  totalTargets: 4,
};

test("B1.6 ready only if no generation/attempt underway and no initial product opt-in", () => {
  const result = evaluateOperationalReadiness(clear);
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(Object.keys(result), ["stage", "ready", "counts", "blockers"]);
});

test("B1.6 refuses outstanding generation and schedule states individually", () => {
  for (const key of [
    "generationRunsRunning", "generationRunsPending",
    "targetScheduleRunsRunning", "targetScheduleAttemptsRunning",
  ]) {
    assert.equal(evaluateOperationalReadiness({ ...clear, [key]: 1 }).ready, false, key);
  }
});

test("B1.6 blocks unexpected newly active opt-ins and inconsistent count data", () => {
  assert.equal(evaluateOperationalReadiness({ ...clear, productOptInsEnabled: 1 }).ready, false);
  assert.equal(evaluateOperationalReadiness({ ...clear, productOptInsWithoutConfirmation: 1 }).ready, false);
  assert.equal(evaluateOperationalReadiness({ ...clear, enabledTargets: 5 }).ready, false);
  assert.equal(evaluateOperationalReadiness({ ...clear, totalTargets: -1 }).ready, false);
  assert.equal(evaluateOperationalReadiness({ ...clear, generationRunsRunning: NaN }).ready, false);
});

test("B1.6 read query requests only aggregate counts without fetching identities", async () => {
  const queries = [];
  const handle = (name) => ({
    count: async (args) => { queries.push({ name, args }); return 0; },
  });
  const prisma = {
    generationRun: handle("generationRun"),
    targetScheduleRun: handle("targetScheduleRun"),
    targetScheduleAttempt: handle("targetScheduleAttempt"),
    targetPlaybackReserveActivation: handle("targetPlaybackReserveActivation"),
    targetPlaylist: handle("targetPlaylist"),
  };
  const result = await readOperationalCounts(prisma);
  assert.deepEqual(result, {
    ...clear,
    enabledTargets: 0,
    totalTargets: 0,
  });
  assert.equal(queries.length, 8);
  assert.equal(queries.every(x => !["findMany", "findFirst", "update", "create"].includes(x.name)), true);
  assert.doesNotMatch(JSON.stringify(result), /email|spotify|targetId|secret/i);
});
