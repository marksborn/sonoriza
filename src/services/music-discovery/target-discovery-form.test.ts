import assert from "node:assert/strict";
import test from "node:test";

import { targetDiscoveryPolicyFromForm } from "./target-discovery-form";

test("unchecked discovery master persists a safe globally disabled policy", () => {
  assert.deepEqual(
    targetDiscoveryPolicyFromForm({
      discoveryEnabled: null,
      discoveryFamiliarEnabled: "on",
      discoveryRediscoveryEnabled: "on",
      discoveryNoveltyEnabled: "on",
      discoveryReleasesEnabled: "on",
      discoveryIntensity: "BALANCED",
    }),
    {
      discoveryEnabled: false,
      discoveryFamiliarEnabled: true,
      discoveryRediscoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryReleasesEnabled: true,
      discoveryIntensity: "BALANCED",
    },
  );
});

test("form preserves an explicit per-target discovery combination", () => {
  assert.deepEqual(
    targetDiscoveryPolicyFromForm({
      discoveryEnabled: "on",
      discoveryFamiliarEnabled: null,
      discoveryRediscoveryEnabled: "on",
      discoveryNoveltyEnabled: "on",
      discoveryReleasesEnabled: null,
      discoveryIntensity: "EXPLORATORY",
    }),
    {
      discoveryEnabled: true,
      discoveryFamiliarEnabled: false,
      discoveryRediscoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryReleasesEnabled: false,
      discoveryIntensity: "EXPLORATORY",
    },
  );
});

test("form rejects an unknown intensity instead of silently changing the choice", () => {
  assert.throws(
    () =>
      targetDiscoveryPolicyFromForm({
        discoveryEnabled: "on",
        discoveryFamiliarEnabled: "on",
        discoveryRediscoveryEnabled: "on",
        discoveryNoveltyEnabled: "on",
        discoveryReleasesEnabled: "on",
        discoveryIntensity: "MAXIMUM",
      }),
    /invalid-target-discovery-intensity/,
  );
});
