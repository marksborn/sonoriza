import assert from "node:assert/strict";
import test from "node:test";

import { SavedTracksProfileMaterializationPolicyError } from "@/services/data-policy";
import {
  evaluateLikedTrackReconciliationSafety,
  reconcileLikedTracks,
} from "./liked-track-reconciliation";

test("Gate 5C full reconciliation stops before local/provider reads", async () => {
  await assert.rejects(
    () => reconcileLikedTracks("unused-user", { mode: "APPLY" }),
    SavedTracksProfileMaterializationPolicyError,
  );
});

test("Gate 4C requires an explicit baseline before any full reconciliation", () => {
  assert.deepEqual(
    evaluateLikedTrackReconciliationSafety({
      beforeLikedTracks: 0,
      tracksToUnlike: 0,
      rowsWithoutCanonicalId: 0,
    }),
    {
      status: "BASELINE_REQUIRED",
      reasons: ["BASELINE_REQUIRED"],
      unlikeCount: 0,
      unlikePercent: 0,
      rowsWithoutCanonicalId: 0,
      limits: { maxUnlikes: 25, maxUnlikePercent: 5 },
      automaticApplyAllowed: false,
      manualForceAllowed: false,
    },
  );
});

test("Gate 4C allows one ordinary unlike in a materialized library", () => {
  const safety = evaluateLikedTrackReconciliationSafety({
    beforeLikedTracks: 2827,
    tracksToUnlike: 1,
    rowsWithoutCanonicalId: 0,
  });

  assert.equal(safety.status, "READY");
  assert.deepEqual(safety.reasons, ["SAFE"]);
  assert.equal(safety.unlikeCount, 1);
  assert.ok(safety.unlikePercent > 0 && safety.unlikePercent < 0.1);
  assert.equal(safety.automaticApplyAllowed, true);
  assert.equal(safety.manualForceAllowed, false);
});

test("Gate 4C requires review when absolute unlike count exceeds the default limit", () => {
  const safety = evaluateLikedTrackReconciliationSafety({
    beforeLikedTracks: 2827,
    tracksToUnlike: 26,
    rowsWithoutCanonicalId: 0,
  });

  assert.equal(safety.status, "REVIEW_REQUIRED");
  assert.deepEqual(safety.reasons, ["UNLIKE_COUNT_LIMIT"]);
  assert.equal(safety.automaticApplyAllowed, false);
  assert.equal(safety.manualForceAllowed, true);
});

test("Gate 4C requires review when unlike percentage is suspicious even below absolute limit", () => {
  const safety = evaluateLikedTrackReconciliationSafety({
    beforeLikedTracks: 100,
    tracksToUnlike: 6,
    rowsWithoutCanonicalId: 0,
  });

  assert.equal(safety.status, "REVIEW_REQUIRED");
  assert.deepEqual(safety.reasons, ["UNLIKE_PERCENT_LIMIT"]);
  assert.equal(safety.unlikePercent, 6);
});

test("Gate 4C treats provider rows without canonical identity as a hard blocker", () => {
  const safety = evaluateLikedTrackReconciliationSafety({
    beforeLikedTracks: 2827,
    tracksToUnlike: 1,
    rowsWithoutCanonicalId: 1,
  });

  assert.equal(safety.status, "BLOCKED");
  assert.deepEqual(safety.reasons, ["CANONICAL_ID_GAPS"]);
  assert.equal(safety.automaticApplyAllowed, false);
  assert.equal(safety.manualForceAllowed, false);
});

test("Gate 4C limit boundaries themselves are allowed", () => {
  const safety = evaluateLikedTrackReconciliationSafety({
    beforeLikedTracks: 500,
    tracksToUnlike: 25,
    rowsWithoutCanonicalId: 0,
  });

  assert.equal(safety.unlikePercent, 5);
  assert.equal(safety.status, "READY");
});
