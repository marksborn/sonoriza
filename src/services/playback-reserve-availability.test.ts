import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlaybackReserveAvailability } from "./playback-reserve-availability";

const base = {
  enabled: true,
  linkedToSpotify: true,
  updatePolicy: "REBUILD_DAILY",
  reserveMode: "MUSIC_TRACKS" as const,
  requestedRuntimeMode: "ACTIVE",
  allowedInPilot: true,
};

test("B1 read model only reports eligibility for runtime validation, never proves ACTIVE", () => {
  const status = resolvePlaybackReserveAvailability(base);
  assert.equal(status.status, "ELIGIBLE_FOR_RUNTIME_VALIDATION");
  assert.match(status.explanation, /não comprova ACTIVE/);
});

test("B1 keeps explicit NONE as user choice even when target is allowlisted", () => {
  assert.equal(resolvePlaybackReserveAvailability({ ...base, reserveMode: "NONE" }).status, "DISABLED_BY_CHOICE");
});

test("B1 distinguishes disabled/unlinked from incompatible update modes", () => {
  assert.equal(resolvePlaybackReserveAvailability({ ...base, enabled: false }).status, "TARGET_DISABLED");
  assert.equal(resolvePlaybackReserveAvailability({ ...base, linkedToSpotify: false }).status, "DESTINATION_NOT_LINKED");
  assert.equal(resolvePlaybackReserveAvailability({ ...base, updatePolicy: "MANUAL" }).status, "UNSUPPORTED_UPDATE_POLICY");
});

test("B1 distinguishes global OFF and SHADOW from a missing pilot authorization", () => {
  assert.equal(resolvePlaybackReserveAvailability({ ...base, requestedRuntimeMode: "OFF" }).status, "ROLLOUT_OFF");
  assert.equal(resolvePlaybackReserveAvailability({ ...base, requestedRuntimeMode: "" }).status, "ROLLOUT_SHADOW");
  assert.equal(resolvePlaybackReserveAvailability({ ...base, requestedRuntimeMode: "invalid" }).status, "ROLLOUT_SHADOW");
  assert.equal(resolvePlaybackReserveAvailability({ ...base, allowedInPilot: false }).status, "TARGET_NOT_IN_PILOT");
});

test("B1.2 differentiates optional simulation from productive pilot", () => {
  assert.equal(resolvePlaybackReserveAvailability({
    ...base,
    allowedInPilot: false,
    capabilitySimulationEnabled: true,
  }).status, "SIMULATION_AVAILABLE_REAL_NOT_AUTHORIZED");
  assert.equal(resolvePlaybackReserveAvailability({
    ...base,
    allowedInPilot: false,
    capabilitySimulationEnabled: false,
  }).status, "TARGET_NOT_IN_PILOT");
  assert.equal(resolvePlaybackReserveAvailability({
    ...base,
    reserveMode: "NONE",
    allowedInPilot: false,
    capabilitySimulationEnabled: true,
  }).status, "DISABLED_BY_CHOICE");
});

test("B1.3 keeps user opt-in and technical product activation separate", () => {
  const optIn = {
    ...base,
    allowedInPilot: false,
    productOptInEnabled: true,
    productAuthorizationEnabled: false,
  };
  assert.equal(
    resolvePlaybackReserveAvailability(optIn).status,
    "PRODUCT_OPT_IN_PENDING_ROLLOUT",
  );
  assert.equal(
    resolvePlaybackReserveAvailability({ ...optIn, productAuthorizationEnabled: true }).status,
    "PRODUCT_AUTHORIZED_FOR_RUNTIME_VALIDATION",
  );
  assert.equal(
    resolvePlaybackReserveAvailability({ ...optIn, requestedRuntimeMode: "SHADOW" }).status,
    "ROLLOUT_SHADOW",
  );
});

test("B1 applies the same evaluation to both supported maintenance modes", () => {
  assert.equal(resolvePlaybackReserveAvailability({ ...base, updatePolicy: "KEEP_FILLED" }).status, "ELIGIBLE_FOR_RUNTIME_VALIDATION");
  assert.equal(resolvePlaybackReserveAvailability({ ...base, updatePolicy: "REBUILD_DAILY" }).status, "ELIGIBLE_FOR_RUNTIME_VALIDATION");
});
