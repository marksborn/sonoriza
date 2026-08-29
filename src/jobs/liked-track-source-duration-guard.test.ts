import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLikedTrackDurationGuard,
  LIKED_TRACK_SOURCE_DURATION_DEFICIT_TOLERANCE_MS,
} from "./liked-track-source-shadow";

test("Gate 5B2 duration guard accepts the observed 280 ms residual regression", () => {
  const guard = evaluateLikedTrackDurationGuard({
    targetDurationMs: 36_000_000,
    currentDurationMs: 35_977_899,
    variantDurationMs: 35_977_619,
  });

  assert.equal(LIKED_TRACK_SOURCE_DURATION_DEFICIT_TOLERANCE_MS, 1_000);
  assert.equal(guard.currentDeficitMs, 22_101);
  assert.equal(guard.variantDeficitMs, 22_381);
  assert.equal(guard.deficitDeltaMs, 280);
  assert.equal(guard.regressed, false);
});

test("Gate 5B2 duration guard still rejects material additional deficit", () => {
  const guard = evaluateLikedTrackDurationGuard({
    targetDurationMs: 36_000_000,
    currentDurationMs: 35_977_899,
    variantDurationMs: 35_976_898,
  });

  assert.equal(guard.deficitDeltaMs, 1_001);
  assert.equal(guard.regressed, true);
});

test("Gate 5B2 duration guard uses segmented deficit when planner provides it", () => {
  const accepted = evaluateLikedTrackDurationGuard({
    targetDurationMs: 3_600_000,
    currentDurationMs: 3_590_000,
    variantDurationMs: 3_580_000,
    currentDeficitMs: 250,
    variantDeficitMs: 900,
  });
  const rejected = evaluateLikedTrackDurationGuard({
    targetDurationMs: 3_600_000,
    currentDurationMs: 3_590_000,
    variantDurationMs: 3_580_000,
    currentDeficitMs: 250,
    variantDeficitMs: 1_251,
  });

  assert.equal(accepted.deficitDeltaMs, 650);
  assert.equal(accepted.regressed, false);
  assert.equal(rejected.deficitDeltaMs, 1_001);
  assert.equal(rejected.regressed, true);
});
