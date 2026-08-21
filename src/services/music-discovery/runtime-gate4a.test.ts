import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCOVERY_GATE4A_DEFAULT_REDISCOVERY_CEILING,
  resolveDiscoveryGate4APolicy,
} from "@/jobs/discovery-runtime";

test("Gate 4A stays disabled unless the master flag is explicitly enabled", () => {
  const policy = resolveDiscoveryGate4APolicy({
    userEmail: "allowed@example.com",
    masterEnabled: "false",
    allowlistedEmails: "allowed@example.com",
  });

  assert.equal(policy.enabled, false);
  assert.equal(policy.reason, "MASTER_DISABLED");
});

test("Gate 4A requires an exact case-insensitive email allowlist match", () => {
  const enabled = resolveDiscoveryGate4APolicy({
    userEmail: "Allowed@Example.com",
    masterEnabled: "true",
    allowlistedEmails: "other@example.com, allowed@example.com ",
    rediscoveryCeiling: "0.2",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.reason, "ENABLED");
  assert.equal(enabled.rediscoveryCeiling, 0.2);

  const blocked = resolveDiscoveryGate4APolicy({
    userEmail: "not-allowed@example.com",
    masterEnabled: "true",
    allowlistedEmails: "allowed@example.com",
  });
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.reason, "USER_NOT_ALLOWLISTED");
});

test("Gate 4A fails closed when user email is missing", () => {
  const policy = resolveDiscoveryGate4APolicy({
    userEmail: null,
    masterEnabled: "true",
    allowlistedEmails: "allowed@example.com",
  });

  assert.equal(policy.enabled, false);
  assert.equal(policy.reason, "USER_EMAIL_MISSING");
});

test("Gate 4A uses the calibrated 25% rediscovery ceiling when env input is invalid", () => {
  const policy = resolveDiscoveryGate4APolicy({
    userEmail: "allowed@example.com",
    masterEnabled: "true",
    allowlistedEmails: "allowed@example.com",
    rediscoveryCeiling: "9",
  });

  assert.equal(policy.enabled, true);
  assert.equal(
    policy.rediscoveryCeiling,
    DISCOVERY_GATE4A_DEFAULT_REDISCOVERY_CEILING,
  );
});
