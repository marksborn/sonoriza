import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  canTransitionOnboardingHistoryStatus,
  canTransitionOnboardingStatus,
  historyWaitBlocksOnboarding,
  nextOnboardingStep,
  previousOnboardingStep,
} from "./state";

test("#205 Gate 1 versions the onboarding contract", () => {
  assert.equal(ONBOARDING_VERSION, 1);
});

test("#205 Gate 1 defines deterministic wizard order including Spotify history", () => {
  assert.deepEqual(ONBOARDING_STEPS, [
    "WELCOME",
    "SPOTIFY",
    "SPOTIFY_HISTORY",
    "SOURCES",
    "DESTINATION",
    "MUSIC_BEHAVIOR",
    "CALENDAR",
    "REVIEW",
    "SIMULATION",
    "ACTIVATION",
  ]);

  assert.equal(nextOnboardingStep("WELCOME"), "SPOTIFY");
  assert.equal(nextOnboardingStep("SPOTIFY"), "SPOTIFY_HISTORY");
  assert.equal(nextOnboardingStep("SPOTIFY_HISTORY"), "SOURCES");
  assert.equal(nextOnboardingStep("ACTIVATION"), null);

  assert.equal(previousOnboardingStep("WELCOME"), null);
  assert.equal(previousOnboardingStep("SOURCES"), "SPOTIFY_HISTORY");
});

test("#205 Gate 1 allows normal lifecycle and safe restart", () => {
  assert.equal(
    canTransitionOnboardingStatus("NOT_STARTED", "IN_PROGRESS"),
    true,
  );
  assert.equal(
    canTransitionOnboardingStatus("IN_PROGRESS", "READY_FOR_SIMULATION"),
    true,
  );
  assert.equal(
    canTransitionOnboardingStatus("READY_FOR_SIMULATION", "COMPLETED"),
    true,
  );

  assert.equal(
    canTransitionOnboardingStatus("COMPLETED", "IN_PROGRESS"),
    true,
  );
  assert.equal(
    canTransitionOnboardingStatus("SKIPPED", "IN_PROGRESS"),
    true,
  );

  assert.equal(
    canTransitionOnboardingStatus("NOT_STARTED", "COMPLETED"),
    false,
  );
});

test("#205 Gate 1 extended-history waiting never blocks onboarding", () => {
  for (const status of [
    "NOT_REQUESTED",
    "REQUESTED",
    "FILES_READY",
    "IMPORTING",
    "IMPORTED",
    "FAILED",
  ] as const) {
    assert.equal(historyWaitBlocksOnboarding(status), false);
  }
});

test("#205 Gate 1 history state supports request, import, failure and retry", () => {
  assert.equal(
    canTransitionOnboardingHistoryStatus("NOT_REQUESTED", "REQUESTED"),
    true,
  );
  assert.equal(
    canTransitionOnboardingHistoryStatus("REQUESTED", "FILES_READY"),
    true,
  );
  assert.equal(
    canTransitionOnboardingHistoryStatus("FILES_READY", "IMPORTING"),
    true,
  );
  assert.equal(
    canTransitionOnboardingHistoryStatus("IMPORTING", "IMPORTED"),
    true,
  );

  assert.equal(
    canTransitionOnboardingHistoryStatus("IMPORTING", "FAILED"),
    true,
  );
  assert.equal(
    canTransitionOnboardingHistoryStatus("FAILED", "FILES_READY"),
    true,
  );

  assert.equal(
    canTransitionOnboardingHistoryStatus("NOT_REQUESTED", "IMPORTED"),
    false,
  );
});
