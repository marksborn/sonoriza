import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLikedTrackDurationGuard,
  LIKED_TRACK_SOURCE_DURATION_DEFICIT_MAX_TOLERANCE_MS,
  LIKED_TRACK_SOURCE_DURATION_DEFICIT_MIN_TOLERANCE_MS,
  resolveLikedTrackDurationToleranceMs,
} from "./liked-track-source-shadow";

test("Gate 5B3 duration guard derives 0.05% tolerance for a 10h target", () => {
  assert.equal(
    resolveLikedTrackDurationToleranceMs(36_000_000),
    18_000,
  );

  const observedAvulsa = evaluateLikedTrackDurationGuard({
    targetDurationMs: 36_000_000,
    currentDurationMs: 35_998_831,
    variantDurationMs: 35_990_884,
  });

  assert.equal(observedAvulsa.currentDeficitMs, 1_169);
  assert.equal(observedAvulsa.variantDeficitMs, 9_116);
  assert.equal(observedAvulsa.deficitDeltaMs, 7_947);
  assert.equal(observedAvulsa.toleranceMs, 18_000);
  assert.equal(observedAvulsa.regressed, false);
});

test("Gate 5B3 duration guard rejects a delta above the dynamic tolerance", () => {
  const guard = evaluateLikedTrackDurationGuard({
    targetDurationMs: 36_000_000,
    currentDurationMs: 36_000_000,
    variantDurationMs: 35_981_999,
  });

  assert.equal(guard.toleranceMs, 18_000);
  assert.equal(guard.deficitDeltaMs, 18_001);
  assert.equal(guard.regressed, true);
});

test("Gate 5B3 duration tolerance keeps the 1s floor", () => {
  assert.equal(
    resolveLikedTrackDurationToleranceMs(60_000),
    LIKED_TRACK_SOURCE_DURATION_DEFICIT_MIN_TOLERANCE_MS,
  );
});

test("Gate 5B3 duration tolerance is capped at 30s", () => {
  assert.equal(
    resolveLikedTrackDurationToleranceMs(100_000_000),
    LIKED_TRACK_SOURCE_DURATION_DEFICIT_MAX_TOLERANCE_MS,
  );
});

test("Gate 5B3 duration guard still honors explicit tolerance override", () => {
  const accepted = evaluateLikedTrackDurationGuard({
    targetDurationMs: 3_600_000,
    currentDurationMs: 3_590_000,
    variantDurationMs: 3_580_000,
    currentDeficitMs: 250,
    variantDeficitMs: 1_250,
    toleranceMs: 1_000,
  });

  const rejected = evaluateLikedTrackDurationGuard({
    targetDurationMs: 3_600_000,
    currentDurationMs: 3_590_000,
    variantDurationMs: 3_580_000,
    currentDeficitMs: 250,
    variantDeficitMs: 1_251,
    toleranceMs: 1_000,
  });

  assert.equal(accepted.deficitDeltaMs, 1_000);
  assert.equal(accepted.regressed, false);
  assert.equal(rejected.deficitDeltaMs, 1_001);
  assert.equal(rejected.regressed, true);
});
