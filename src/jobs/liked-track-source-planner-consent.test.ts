import assert from "node:assert/strict";
import test from "node:test";

import { resolveLikedTrackSourcePlannerConsentPolicy } from "./liked-track-source-shadow";

const targetIds = new Set(["target-1"]);

test("Gate 5B2 keeps operational rollout as a necessary first gate", () => {
  const policy = resolveLikedTrackSourcePlannerConsentPolicy({
    operationalPolicy: {
      enabled: false,
      reason: "MASTER_DISABLED",
      targetIds,
    },
    preference: {
      enabled: true,
      explicitlyConfigured: true,
      readError: null,
    },
  });

  assert.deepEqual(policy, {
    enabled: false,
    reason: "MASTER_DISABLED",
    targetIds,
  });
});

test("Gate 5B2 denies productive use when the user preference is absent or disabled", () => {
  const policy = resolveLikedTrackSourcePlannerConsentPolicy({
    operationalPolicy: {
      enabled: true,
      reason: "ENABLED",
      targetIds,
    },
    preference: {
      enabled: false,
      explicitlyConfigured: false,
      readError: null,
    },
  });

  assert.deepEqual(policy, {
    enabled: false,
    reason: "USER_SOURCE_DISABLED",
    targetIds,
  });
});

test("Gate 5B2 fails closed when the persisted preference cannot be read", () => {
  const policy = resolveLikedTrackSourcePlannerConsentPolicy({
    operationalPolicy: {
      enabled: true,
      reason: "ENABLED",
      targetIds,
    },
    preference: {
      enabled: false,
      explicitlyConfigured: false,
      readError: "database unavailable",
    },
  });

  assert.deepEqual(policy, {
    enabled: false,
    reason: "USER_SOURCE_PREFERENCE_ERROR",
    targetIds,
  });
});

test("Gate 5B2 enables productive use only when rollout and user consent are both true", () => {
  const policy = resolveLikedTrackSourcePlannerConsentPolicy({
    operationalPolicy: {
      enabled: true,
      reason: "ENABLED",
      targetIds,
    },
    preference: {
      enabled: true,
      explicitlyConfigured: true,
      readError: null,
    },
  });

  assert.deepEqual(policy, {
    enabled: true,
    reason: "ENABLED",
    targetIds,
  });
});
