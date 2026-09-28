import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLikedTrackDiversityGuard,
  LIKED_TRACK_SOURCE_DIVERSITY_MAX_ALLOWED_LOSS,
} from "./liked-track-source-shadow";

test("Gate 5B3 accepts the observed Avulsa artist diversity delta", () => {
  const guard = evaluateLikedTrackDiversityGuard({
    currentCount: 131,
    variantCount: 128,
  });

  assert.equal(guard.allowedLoss, 3);
  assert.equal(guard.loss, 3);
  assert.equal(guard.regressed, false);
});

test("Gate 5B3 accepts the observed Avulsa album diversity delta", () => {
  const guard = evaluateLikedTrackDiversityGuard({
    currentCount: 141,
    variantCount: 138,
  });

  assert.equal(guard.allowedLoss, 3);
  assert.equal(guard.loss, 3);
  assert.equal(guard.regressed, false);
});

test("Gate 5B3 rejects diversity loss above the bounded threshold", () => {
  const guard = evaluateLikedTrackDiversityGuard({
    currentCount: 131,
    variantCount: 127,
  });

  assert.equal(
    guard.allowedLoss,
    LIKED_TRACK_SOURCE_DIVERSITY_MAX_ALLOWED_LOSS,
  );
  assert.equal(guard.loss, 4);
  assert.equal(guard.regressed, true);
});

test("Gate 5B3 keeps at least one identity of tolerance for normal small sets", () => {
  const accepted = evaluateLikedTrackDiversityGuard({
    currentCount: 20,
    variantCount: 19,
  });

  const rejected = evaluateLikedTrackDiversityGuard({
    currentCount: 20,
    variantCount: 18,
  });

  assert.equal(accepted.allowedLoss, 1);
  assert.equal(accepted.regressed, false);
  assert.equal(rejected.loss, 2);
  assert.equal(rejected.regressed, true);
});

test("Gate 5B3 explicit diversity override remains fail-closed", () => {
  const guard = evaluateLikedTrackDiversityGuard({
    currentCount: 100,
    variantCount: 98,
    allowedLoss: 1,
  });

  assert.equal(guard.allowedLoss, 1);
  assert.equal(guard.loss, 2);
  assert.equal(guard.regressed, true);
});
