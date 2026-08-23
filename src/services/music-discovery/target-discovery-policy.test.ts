import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TARGET_DISCOVERY_POLICY,
  TARGET_DISCOVERY_POLICY_SEMANTICS,
  allowedTargetDiscoveryFamilies,
  discoveryIntensityRank,
  normalizeTargetDiscoveryPolicy,
  serializeTargetDiscoveryPolicy,
  targetAllowsDiscoveryFamily,
} from "./target-discovery-policy";

test("defaults preserve existing target behavior with discovery disabled", () => {
  const policy = normalizeTargetDiscoveryPolicy(null);

  assert.equal(policy.enabled, false);
  assert.equal(policy.intensity, "BALANCED");
  assert.deepEqual(allowedTargetDiscoveryFamilies(policy), []);
  assert.deepEqual(policy, DEFAULT_TARGET_DISCOVERY_POLICY);
});

test("default persistence keeps discovery globally disabled", () => {
  assert.deepEqual(serializeTargetDiscoveryPolicy(DEFAULT_TARGET_DISCOVERY_POLICY), {
    discoveryEnabled: false,
    discoveryFamiliarEnabled: true,
    discoveryRediscoveryEnabled: true,
    discoveryNoveltyEnabled: true,
    discoveryReleasesEnabled: true,
    discoveryIntensity: "BALANCED",
  });
});

test("persisted target policy round-trips without losing per-target choices", () => {
  const policy = normalizeTargetDiscoveryPolicy({
    discoveryEnabled: true,
    discoveryFamiliarEnabled: false,
    discoveryRediscoveryEnabled: true,
    discoveryNoveltyEnabled: false,
    discoveryReleasesEnabled: true,
    discoveryIntensity: "EXPLORATORY",
  });

  assert.deepEqual(normalizeTargetDiscoveryPolicy(serializeTargetDiscoveryPolicy(policy)), policy);
});

test("enabling discovery exposes only the selected families", () => {
  const policy = normalizeTargetDiscoveryPolicy({
    discoveryEnabled: true,
    discoveryFamiliarEnabled: true,
    discoveryRediscoveryEnabled: false,
    discoveryNoveltyEnabled: true,
    discoveryReleasesEnabled: false,
    discoveryIntensity: "EXPLORATORY",
  });

  assert.deepEqual(allowedTargetDiscoveryFamilies(policy), [
    "FAMILIAR",
    "DISCOVERY",
  ]);
  assert.equal(targetAllowsDiscoveryFamily(policy, "FAMILIAR"), true);
  assert.equal(targetAllowsDiscoveryFamily(policy, "REDISCOVERY"), false);
  assert.equal(targetAllowsDiscoveryFamily(policy, "DISCOVERY"), true);
  assert.equal(targetAllowsDiscoveryFamily(policy, "RELEASE"), false);
});

test("legacy or partially persisted rows keep subtype defaults but remain globally disabled", () => {
  const policy = normalizeTargetDiscoveryPolicy({
    discoveryEnabled: false,
    discoveryFamiliarEnabled: null,
    discoveryRediscoveryEnabled: null,
    discoveryNoveltyEnabled: null,
    discoveryReleasesEnabled: null,
    discoveryIntensity: null,
  });

  assert.equal(policy.enabled, false);
  assert.equal(policy.familiarEnabled, true);
  assert.equal(policy.rediscoveryEnabled, true);
  assert.equal(policy.discoveryEnabled, true);
  assert.equal(policy.releasesEnabled, true);
  assert.equal(policy.intensity, "BALANCED");
  assert.deepEqual(allowedTargetDiscoveryFamilies(policy), []);
});

test("invalid persisted intensity falls back conservatively to the product default", () => {
  const policy = normalizeTargetDiscoveryPolicy({
    discoveryEnabled: true,
    discoveryIntensity: "MAXIMUM",
  });

  assert.equal(policy.intensity, "BALANCED");
  assert.equal(discoveryIntensityRank(policy.intensity), 2);
});

test("intensity is an ordinal enrichment level, not a mandatory percentage quota", () => {
  assert.equal(discoveryIntensityRank("CONSERVATIVE"), 1);
  assert.equal(discoveryIntensityRank("BALANCED"), 2);
  assert.equal(discoveryIntensityRank("EXPLORATORY"), 3);
  assert.equal(
    TARGET_DISCOVERY_POLICY_SEMANTICS.composition,
    "ENRICHMENT_NOT_REQUIRED_QUOTA",
  );
  assert.equal(
    TARGET_DISCOVERY_POLICY_SEMANTICS.weakCandidateBehavior,
    "DO_NOT_FORCE_DISCOVERY_FILL",
  );
});

test("album recommendation is explicitly outside per-target track families", () => {
  assert.equal(
    TARGET_DISCOVERY_POLICY_SEMANTICS.albums,
    "EXCLUDED_FROM_TRACK_CANDIDATE_FAMILIES",
  );

  const policy = normalizeTargetDiscoveryPolicy({ discoveryEnabled: true });
  assert.deepEqual(allowedTargetDiscoveryFamilies(policy), [
    "FAMILIAR",
    "REDISCOVERY",
    "DISCOVERY",
    "RELEASE",
  ]);
});
