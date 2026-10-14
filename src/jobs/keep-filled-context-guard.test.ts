import assert from "node:assert/strict";
import test from "node:test";

import { missingKeepFilledPreparation } from "./keep-filled-context-guard";

const academy = { id: "academy", updatePolicy: "KEEP_FILLED" };
const daily = { id: "daily", updatePolicy: "REBUILD_DAILY" };
const safeContext = {
  scheduledPolicyByTargetId: { academy: "KEEP_FILLED" },
  keepFilledByTargetId: {
    academy: {
      snapshotBefore: "spotify-snapshot-1",
      preservedUris: ["spotify:track:old"],
      removeUris: [],
    },
  },
  preservedByTargetId: { academy: [{ uri: "spotify:track:old" }] },
} as const;

test("#460 blocks real individual KEEP_FILLED with missing context", () => {
  assert.deepEqual(missingKeepFilledPreparation({
    simulate: false, targetScope: ["academy"], targets: [academy],
  }), ["academy"]);
});

test("#460 blocks real unscoped generation when KEEP_FILLED would be replaced", () => {
  assert.deepEqual(missingKeepFilledPreparation({
    simulate: false, targetScope: null, targets: [daily, academy],
  }), ["academy"]);
});

test("#460 blocks scoped preview without the current KEEP_FILLED snapshot", () => {
  assert.deepEqual(missingKeepFilledPreparation({
    simulate: true, targetScope: ["academy"], targets: [academy],
  }), ["academy"]);
});

test("#460 allows a prepared KEEP_FILLED snapshot for scheduled and inline simulation", () => {
  for (const simulate of [false, true]) {
    assert.deepEqual(missingKeepFilledPreparation({
      simulate, targetScope: ["academy"], targets: [academy], ...safeContext,
    }), []);
  }
});

test("#460 rejects missing preservation list, empty snapshot and absent policy", () => {
  const noPreserved = { ...safeContext, preservedByTargetId: {} };
  const noSnapshot = {
    ...safeContext,
    keepFilledByTargetId: { academy: { ...safeContext.keepFilledByTargetId.academy, snapshotBefore: " " } },
  };
  const noPolicy = { ...safeContext, scheduledPolicyByTargetId: {} };
  for (const partial of [noPreserved, noSnapshot, noPolicy]) {
    assert.deepEqual(missingKeepFilledPreparation({
      simulate: false, targetScope: ["academy"], targets: [academy], ...partial,
    }), ["academy"]);
  }
});

test("#460 keeps other update policies and unscoped onboarding simulation unchanged", () => {
  assert.deepEqual(missingKeepFilledPreparation({
    simulate: false, targetScope: ["daily"], targets: [daily],
  }), []);
  assert.deepEqual(missingKeepFilledPreparation({
    simulate: true, targetScope: null, targets: [daily, academy],
  }), []);
});

test("#460 accepts a prepared empty prefix when KEEP_FILLED has nothing to preserve", () => {
  assert.deepEqual(missingKeepFilledPreparation({
    simulate: false, targetScope: ["academy"], targets: [academy],
    ...safeContext, preservedByTargetId: { academy: [] },
  }), []);
});
