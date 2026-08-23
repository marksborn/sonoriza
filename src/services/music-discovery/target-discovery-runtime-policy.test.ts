import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTargetDiscoveryRuntimeTargets,
  resolveTargetDiscoveryRuntimePolicy,
  targetDiscoveryPolicyFingerprint,
  targetDiscoveryRuntimeCaps,
  targetUsesExternalDiscovery,
  targetUsesSourceDiscovery,
} from "./target-discovery-runtime-policy";

test("Gate 5 target runtime is fail-closed behind base discovery, flag and allowlist", () => {
  assert.deepEqual(
    resolveTargetDiscoveryRuntimePolicy({
      baseDiscoveryEnabled: false,
      userEmail: "user@example.com",
      masterEnabled: "true",
      allowlistedEmails: "user@example.com",
    }),
    { enabled: false, reason: "BASE_DISCOVERY_DISABLED" },
  );
  assert.deepEqual(
    resolveTargetDiscoveryRuntimePolicy({
      baseDiscoveryEnabled: true,
      userEmail: "user@example.com",
      masterEnabled: "false",
      allowlistedEmails: "user@example.com",
    }),
    { enabled: false, reason: "MASTER_DISABLED" },
  );
  assert.deepEqual(
    resolveTargetDiscoveryRuntimePolicy({
      baseDiscoveryEnabled: true,
      userEmail: "user@example.com",
      masterEnabled: "true",
      allowlistedEmails: "other@example.com",
    }),
    { enabled: false, reason: "USER_NOT_ALLOWLISTED" },
  );
  assert.deepEqual(
    resolveTargetDiscoveryRuntimePolicy({
      baseDiscoveryEnabled: true,
      userEmail: "USER@example.com",
      masterEnabled: "true",
      allowlistedEmails: "user@example.com",
    }),
    { enabled: true, reason: "ENABLED" },
  );
});

test("target policy remains independent and master OFF suppresses every enrichment family", () => {
  const policies = normalizeTargetDiscoveryRuntimeTargets([
    {
      targetPlaylistId: "carro",
      persistedPolicy: { discoveryEnabled: false },
    },
    {
      targetPlaylistId: "academia",
      persistedPolicy: {
        discoveryEnabled: true,
        discoveryFamiliarEnabled: false,
        discoveryRediscoveryEnabled: true,
        discoveryNoveltyEnabled: false,
        discoveryReleasesEnabled: true,
        discoveryIntensity: "EXPLORATORY",
      },
    },
  ]);

  const carro = policies.get("carro")!;
  const academia = policies.get("academia")!;

  assert.equal(targetUsesSourceDiscovery(carro), false);
  assert.equal(targetUsesExternalDiscovery(carro), false);
  assert.equal(targetUsesSourceDiscovery(academia), true);
  assert.equal(targetUsesExternalDiscovery(academia), false);
  assert.notEqual(
    targetDiscoveryPolicyFingerprint(carro),
    targetDiscoveryPolicyFingerprint(academia),
  );
});

test("intensity changes internal allowance without creating a required quota or relaxing validated maxima", () => {
  assert.deepEqual(targetDiscoveryRuntimeCaps("CONSERVATIVE"), {
    rediscoveryCeiling: 0.15,
    externalDiscoveryCeiling: 0.1,
  });
  assert.deepEqual(targetDiscoveryRuntimeCaps("BALANCED"), {
    rediscoveryCeiling: 0.25,
    externalDiscoveryCeiling: 0.2,
  });
  assert.deepEqual(targetDiscoveryRuntimeCaps("EXPLORATORY"), {
    rediscoveryCeiling: 0.25,
    externalDiscoveryCeiling: 0.2,
  });
});
