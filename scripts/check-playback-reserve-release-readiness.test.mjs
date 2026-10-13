import assert from "node:assert/strict";
import test from "node:test";
import { inspectReleaseEnvironment } from "./check-playback-reserve-release-readiness.mjs";

const safe = {
  PLAYBACK_RESERVE_RUNTIME_MODE: "ACTIVE",
  PLAYBACK_RESERVE_ACTIVE_TARGET_IDS: "target-A,target-B",
};

test("B1.5 baseline prints only aggregate counts and a salted-independent fingerprint, not raw IDs", () => {
  const result = inspectReleaseEnvironment(safe);
  assert.equal(result.ready, true);
  assert.equal(result.legacyPilot.count, 2);
  assert.match(result.legacyPilot.fingerprintSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /target-A|target-B/);
});

test("B1.5 blocks accidental activation of either new feature by env", () => {
  for (const key of ["PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE", "PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE"]) {
    const result = inspectReleaseEnvironment({ ...safe, [key]: "ACTIVE" });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.length);
  }
});

test("B1.5 legacy pilot set is order-independent but identity-sensitive", () => {
  const baseline = inspectReleaseEnvironment(safe);
  const expected = { legacyCount: 2, legacyHash: baseline.legacyPilot.fingerprintSha256, runtimeMode: "ACTIVE" };
  assert.equal(inspectReleaseEnvironment({ ...safe, PLAYBACK_RESERVE_ACTIVE_TARGET_IDS: "target-B, target-A" }, expected).ready, true);
  assert.equal(inspectReleaseEnvironment({ ...safe, PLAYBACK_RESERVE_ACTIVE_TARGET_IDS: "target-A,target-C" }, expected).ready, false);
  assert.equal(inspectReleaseEnvironment({ ...safe, PLAYBACK_RESERVE_ACTIVE_TARGET_IDS: "target-A" }, expected).ready, false);
  assert.equal(inspectReleaseEnvironment({ ...safe, PLAYBACK_RESERVE_RUNTIME_MODE: "OFF" }, expected).ready, false);
});

test("B1.5 absent mode is safe but invalid/unknown modes require review", () => {
  assert.equal(inspectReleaseEnvironment({}).ready, true);
  assert.equal(inspectReleaseEnvironment({ ...safe, PLAYBACK_RESERVE_RUNTIME_MODE: "WRITES_ON" }).ready, false);
  assert.equal(inspectReleaseEnvironment({ ...safe, PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE: "wrong" }).ready, false);
  assert.equal(inspectReleaseEnvironment({ ...safe, PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE: "invalid" }).ready, false);
});

test("B1.5 verify requires full valid input", () => {
  const hash = inspectReleaseEnvironment(safe).legacyPilot.fingerprintSha256;
  assert.equal(inspectReleaseEnvironment(safe, { legacyCount: 2, legacyHash: "bad", runtimeMode: "ACTIVE" }).ready, false);
  assert.equal(inspectReleaseEnvironment(safe, { legacyCount: -1, legacyHash: hash, runtimeMode: "ACTIVE" }).ready, false);
});
