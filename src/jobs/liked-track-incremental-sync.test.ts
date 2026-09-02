import assert from "node:assert/strict";
import test from "node:test";

import { resolveLikedTrackIncrementalSyncPolicy } from "./liked-track-incremental-sync";

test("Gate 5C incremental cron is blocked by source capability before rollout controls", () => {
  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
    }),
    { enabled: false, reason: "SOURCE_CAPABILITY_BLOCKED" },
  );
});

test("legacy incremental rollout controls remain fail-closed after source capability approval", () => {
  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: undefined,
      allowlistedEmails: "pilot@example.com",
      sourceCapabilityAllowed: true,
    }),
    { enabled: false, reason: "MASTER_DISABLED" },
  );

  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "other@example.com",
      sourceCapabilityAllowed: true,
    }),
    { enabled: false, reason: "USER_NOT_ALLOWLISTED" },
  );

  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: null,
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
      sourceCapabilityAllowed: true,
    }),
    { enabled: false, reason: "USER_EMAIL_MISSING" },
  );

  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: " Pilot@Example.com ",
      masterEnabled: "on",
      allowlistedEmails: "pilot@example.com,other@example.com",
      sourceCapabilityAllowed: true,
    }),
    { enabled: true, reason: "ENABLED" },
  );
});
