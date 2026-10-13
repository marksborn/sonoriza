import assert from "node:assert/strict";
import test from "node:test";

import {
  canEnableTargetReserveActivation,
  DEFAULT_TARGET_RESERVE_ACTIVATION,
  productReserveAuthorizationRequested,
} from "./playback-reserve-product-activation";

test("B1.3 default is OFF and independent from policy inheritance", () => {
  assert.equal(DEFAULT_TARGET_RESERVE_ACTIVATION.enabled, false);
  assert.equal(DEFAULT_TARGET_RESERVE_ACTIVATION.confirmedAt, null);
});

test("B1.3 cannot opt in without a compatible destination and a real policy", () => {
  const base = {
    enabled: true,
    spotifyPlaylistId: "linked",
    updatePolicy: "REBUILD_DAILY",
    effectivePolicy: { reserveMode: "MUSIC_TRACKS" as const },
  };
  assert.equal(canEnableTargetReserveActivation(base), true);
  assert.equal(canEnableTargetReserveActivation({ ...base, updatePolicy: "KEEP_FILLED" }), true);
  assert.equal(canEnableTargetReserveActivation({ ...base, updatePolicy: "MANUAL" }), false);
  assert.equal(canEnableTargetReserveActivation({ ...base, enabled: false }), false);
  assert.equal(canEnableTargetReserveActivation({ ...base, spotifyPlaylistId: null }), false);
  assert.equal(canEnableTargetReserveActivation({ ...base, effectivePolicy: { reserveMode: "NONE" } }), false);
});

test("B1.3 productive request requires explicit opt-in AND a separate rollout switch", () => {
  const base = {
    productMode: "ACTIVE",
    explicitlyScopedToSingleTarget: true,
    targetEnabled: true,
    targetLinkedToSpotify: true,
    policySupportsMaintenance: true,
    reserveMode: "MUSIC_TRACKS" as const,
    activation: { enabled: true, confirmedAt: new Date("2026-10-13T12:00:00.000Z") },
  };
  assert.equal(productReserveAuthorizationRequested(base), true);
  assert.equal(productReserveAuthorizationRequested({ ...base, productMode: undefined }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, productMode: "OFF" }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, productMode: "SHADOW" }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, explicitlyScopedToSingleTarget: false }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, targetEnabled: false }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, targetLinkedToSpotify: false }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, policySupportsMaintenance: false }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, reserveMode: "NONE" }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, activation: null }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, activation: { enabled: false, confirmedAt: base.activation.confirmedAt } }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, activation: { enabled: true, confirmedAt: null } }), false);
  assert.equal(productReserveAuthorizationRequested({ ...base, activation: { enabled: true, confirmedAt: new Date("invalid") } }), false);
});
