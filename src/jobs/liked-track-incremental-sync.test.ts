import assert from "node:assert/strict";
import test from "node:test";

import { resolveLikedTrackIncrementalSyncPolicy } from "./liked-track-incremental-sync";

test("operational incremental cron is enabled by the reviewed planner capability", () => {
  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
    }),
    { enabled: true, reason: "ENABLED" },
  );
});

test("operational incremental cron still fails closed when the source capability is blocked", () => {
  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
      sourceCapabilityAllowed: false,
    }),
    { enabled: false, reason: "SOURCE_CAPABILITY_BLOCKED" },
  );
});

test("operational incremental rollout controls remain fail-closed", () => {
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
