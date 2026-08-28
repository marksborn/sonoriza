import assert from "node:assert/strict";
import test from "node:test";

import { resolveLikedTrackReconciliationPolicy } from "./liked-track-reconciliation";

test("Gate 4C reconciliation cron is fail-closed until master and user allowlist agree", () => {
  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: undefined,
      allowlistedEmails: "pilot@example.com",
    }),
    { enabled: false, reason: "MASTER_DISABLED" },
  );

  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "other@example.com",
    }),
    { enabled: false, reason: "USER_NOT_ALLOWLISTED" },
  );

  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: null,
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
    }),
    { enabled: false, reason: "USER_EMAIL_MISSING" },
  );

  assert.deepEqual(
    resolveLikedTrackReconciliationPolicy({
      userEmail: " Pilot@Example.com ",
      masterEnabled: "on",
      allowlistedEmails: "pilot@example.com,other@example.com",
    }),
    { enabled: true, reason: "ENABLED" },
  );
});
