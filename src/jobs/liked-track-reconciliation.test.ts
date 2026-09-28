import assert from "node:assert/strict";
import test from "node:test";

import { resolveLikedTrackReconciliationPolicy } from "./liked-track-reconciliation";

test("operational reconciliation cron is enabled by the reviewed planner capability", () => {
  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
    }),
    { enabled: true, reason: "ENABLED" },
  );
});

test("operational reconciliation cron still fails closed when the source capability is blocked", () => {
  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
      sourceCapabilityAllowed: false,
    }),
    { enabled: false, reason: "SOURCE_CAPABILITY_BLOCKED" },
  );
});

test("operational reconciliation rollout controls remain fail-closed", () => {
  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: undefined,
      allowlistedEmails: "pilot@example.com",
      sourceCapabilityAllowed: true,
    }),
    { enabled: false, reason: "MASTER_DISABLED" },
  );

  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "other@example.com",
      sourceCapabilityAllowed: true,
    }),
    { enabled: false, reason: "USER_NOT_ALLOWLISTED" },
  );

  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: null,
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
      sourceCapabilityAllowed: true,
    }),
    { enabled: false, reason: "USER_EMAIL_MISSING" },
  );

  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: " Pilot@Example.com ",
      masterEnabled: "on",
      allowlistedEmails: "pilot@example.com,other@example.com",
      sourceCapabilityAllowed: true,
    }),
    { enabled: true, reason: "ENABLED" },
  );
});
