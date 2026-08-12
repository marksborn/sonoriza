import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  formatDurationCompact,
  isStalePushStatus,
  notificationPreferenceAllows,
  retryDelayMs,
  sanitizeNotificationReason,
  sanitizeNotificationUrl,
} from "./core";

test("NOOP is opt-in while generation, cleanup and error default on", () => {
  assert.equal(
    notificationPreferenceAllows("GENERATION", DEFAULT_NOTIFICATION_PREFERENCES),
    true,
  );
  assert.equal(
    notificationPreferenceAllows("CLEANUP", DEFAULT_NOTIFICATION_PREFERENCES),
    true,
  );
  assert.equal(
    notificationPreferenceAllows("ERROR", DEFAULT_NOTIFICATION_PREFERENCES),
    true,
  );
  assert.equal(
    notificationPreferenceAllows("NOOP", DEFAULT_NOTIFICATION_PREFERENCES),
    false,
  );
});

test("notification URLs remain inside authenticated dashboard routes", () => {
  assert.equal(
    sanitizeNotificationUrl("/dashboard/playlists/abc"),
    "/dashboard/playlists/abc",
  );
  assert.equal(sanitizeNotificationUrl("https://evil.invalid"), "/dashboard");
  assert.equal(sanitizeNotificationUrl("/api/generate"), "/dashboard");
});

test("notification reasons redact bearer credentials and stay compact", () => {
  const value = sanitizeNotificationReason(
    "Spotify failed with Bearer secret-token-value while doing something",
    60,
  );
  assert.ok(value);
  assert.equal(value!.includes("secret-token-value"), false);
  assert.ok(value!.length <= 60);
});

test("stale endpoints and retry delays are deterministic", () => {
  assert.equal(isStalePushStatus(404), true);
  assert.equal(isStalePushStatus(410), true);
  assert.equal(isStalePushStatus(429), false);
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 300_000);
  assert.equal(retryDelayMs(3), 1_800_000);
});

test("duration formatting is compact for operational notifications", () => {
  assert.equal(formatDurationCompact(46 * 60_000), "46min");
  assert.equal(formatDurationCompact(8 * 60 * 60_000), "8h");
  assert.equal(formatDurationCompact(65 * 60_000), "1h 05min");
});
