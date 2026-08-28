import assert from "node:assert/strict";
import test from "node:test";

import { resolveLikedTrackIncrementalSyncPolicy } from "./liked-track-incremental-sync";

test("Gate 4B incremental cron is fail-closed until master and user allowlist agree", () => {
  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: undefined,
      allowlistedEmails: "pilot@example.com",
    }),
    { enabled: false, reason: "MASTER_DISABLED" },
  );

  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "other@example.com",
    }),
    { enabled: false, reason: "USER_NOT_ALLOWLISTED" },
  );

  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: null,
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
    }),
    { enabled: false, reason: "USER_EMAIL_MISSING" },
  );

  assert.deepEqual(
    resolveLikedTrackIncrementalSyncPolicy({
      userEmail: " Pilot@Example.com ",
      masterEnabled: "on",
      allowlistedEmails: "pilot@example.com,other@example.com",
    }),
    { enabled: true, reason: "ENABLED" },
  );
});
