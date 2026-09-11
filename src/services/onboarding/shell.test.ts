import assert from "node:assert/strict";
import test from "node:test";

import {
  GATE2_LAST_IMPLEMENTED_STEP,
  appendPersistedStep,
  gate2CanAdvance,
  gate2CanGoBack,
  gate2NextStep,
  gate2PreviousStep,
  onboardingProgressPosition,
  readPersistedStepList,
} from "./shell";

test("#205 Gate 2 exposes deterministic progress", () => {
  assert.deepEqual(onboardingProgressPosition("WELCOME"), {
    current: 1,
    total: 10,
  });

  assert.deepEqual(onboardingProgressPosition("SPOTIFY"), {
    current: 2,
    total: 10,
  });

  assert.deepEqual(onboardingProgressPosition("ACTIVATION"), {
    current: 10,
    total: 10,
  });
});

test("#205 Gate 2 only unlocks WELCOME -> SPOTIFY", () => {
  assert.equal(GATE2_LAST_IMPLEMENTED_STEP, "SPOTIFY");

  assert.equal(gate2CanAdvance("WELCOME"), true);
  assert.equal(gate2NextStep("WELCOME"), "SPOTIFY");

  for (const step of [
    "SPOTIFY",
    "SPOTIFY_HISTORY",
    "SOURCES",
    "DESTINATION",
    "MUSIC_BEHAVIOR",
    "CALENDAR",
    "REVIEW",
    "SIMULATION",
    "ACTIVATION",
  ] as const) {
    assert.equal(gate2CanAdvance(step), false);
    assert.equal(gate2NextStep(step), null);
  }
});

test("#205 Gate 2 permits safe back navigation from Spotify shell", () => {
  assert.equal(gate2CanGoBack("SPOTIFY"), true);
  assert.equal(gate2PreviousStep("SPOTIFY"), "WELCOME");

  assert.equal(gate2CanGoBack("WELCOME"), false);
  assert.equal(gate2PreviousStep("WELCOME"), null);
});

test("#205 Gate 2 sanitizes persisted step arrays", () => {
  assert.deepEqual(
    readPersistedStepList([
      "WELCOME",
      "WELCOME",
      "SOURCES",
      "INVALID",
      123,
      null,
    ]),
    ["WELCOME", "SOURCES"],
  );
});

test("#205 Gate 2 completion append stays idempotent", () => {
  assert.deepEqual(
    appendPersistedStep(["WELCOME"], "WELCOME"),
    ["WELCOME"],
  );

  assert.deepEqual(
    appendPersistedStep([], "SPOTIFY"),
    ["SPOTIFY"],
  );
});
