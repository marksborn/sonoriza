import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_SPOTIFY_WRITE_TIMEOUT_MS,
  ProviderReadTimeoutError,
  spotifyWriteTimeoutMs,
} from "@/services/provider-read-deadline";
import { SpotifyApiError } from "@/services/spotify/errors";

import {
  DEFAULT_FAILED_RETRY_AFTER_MS,
  failedRetryAfterMs,
  isProviderReadTimeout,
  isSpotifyWriteTimeout,
  scheduleStatus,
} from "./schedule-retry-policy";

test("#435 Gate 3F pre-write provider timeout keeps the slot retryable", () => {
  assert.equal(
    scheduleStatus("FAILED", null, { retryableBeforeWrite: true }),
    "FAILED",
  );
});

test("#435 Gate 3F other FAILED generations remain BLOCKED (terminal)", () => {
  assert.equal(scheduleStatus("FAILED", null), "BLOCKED");
  assert.equal(scheduleStatus("FAILED", null, {}), "BLOCKED");
  assert.equal(
    scheduleStatus("FAILED", null, { retryableBeforeWrite: "true" }),
    "BLOCKED",
  );
  assert.equal(scheduleStatus("FAILED", null, [{ retryableBeforeWrite: true }]), "BLOCKED");
  assert.equal(
    scheduleStatus("FAILED", null, {
      inconclusiveReason: "QUOTA_EXCEEDED",
    }),
    "BLOCKED",
  );
});

test("#435 Gate 3F SUCCESS, NOOP and PARTIAL mapping is unchanged", () => {
  assert.equal(scheduleStatus("SUCCESS", null), "SUCCESS");
  assert.equal(scheduleStatus("SUCCESS", { maintenanceNoop: true }), "NOOP");
  assert.equal(scheduleStatus("PARTIAL", null), "PARTIAL");
  // A retryable flag never downgrades a successful or partial result.
  assert.equal(
    scheduleStatus("PARTIAL", null, { retryableBeforeWrite: true }),
    "PARTIAL",
  );
  assert.equal(
    scheduleStatus("SUCCESS", null, { retryableBeforeWrite: true }),
    "SUCCESS",
  );
});

test("#435 Gate 3F FAILED retry delay defaults to one cron tick and is bounded", () => {
  assert.equal(DEFAULT_FAILED_RETRY_AFTER_MS, 5 * 60 * 1000);
  assert.equal(failedRetryAfterMs(undefined), DEFAULT_FAILED_RETRY_AFTER_MS);
  assert.equal(failedRetryAfterMs(""), DEFAULT_FAILED_RETRY_AFTER_MS);
  assert.equal(failedRetryAfterMs("120000"), 120_000);
  assert.equal(failedRetryAfterMs("1800000"), 1_800_000);
  // Out of range or malformed values fall back instead of disabling the guard.
  assert.equal(failedRetryAfterMs("0"), DEFAULT_FAILED_RETRY_AFTER_MS);
  assert.equal(failedRetryAfterMs("1000"), DEFAULT_FAILED_RETRY_AFTER_MS);
  assert.equal(failedRetryAfterMs("3600000"), DEFAULT_FAILED_RETRY_AFTER_MS);
  assert.equal(failedRetryAfterMs("abc"), DEFAULT_FAILED_RETRY_AFTER_MS);
  assert.equal(failedRetryAfterMs("90000.5"), DEFAULT_FAILED_RETRY_AFTER_MS);
});

test("#435 Gate 3F recognizes only provider read timeouts", () => {
  assert.equal(
    isProviderReadTimeout(
      new ProviderReadTimeoutError("google-calendar", "events", 10_000),
    ),
    true,
  );
  assert.equal(
    isProviderReadTimeout(
      new SpotifyApiError({
        kind: "READ_TIMEOUT",
        status: 0,
        method: "GET",
        operation: "playlist-items",
        reason: "READ_TIMEOUT",
        retryable: true,
        message: "timeout",
      }),
    ),
    true,
  );
  assert.equal(
    isProviderReadTimeout(
      new SpotifyApiError({
        kind: "RATE_LIMITED",
        status: 429,
        method: "GET",
        operation: "playlist-items",
        retryable: true,
        message: "rate limited",
      }),
    ),
    false,
  );
  assert.equal(isProviderReadTimeout(new Error("timed out after 10000ms")), false);
  assert.equal(isProviderReadTimeout(null), false);
});

test("#435 Gate 3F generation flags retryability only before the first provider write", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");

  const flagSet = source.indexOf("providerWriteStarted = true;");
  const writeCheckpoint = source.indexOf('"PROVIDER_WRITE_START"', flagSet);
  assert.notEqual(flagSet, -1);
  assert.notEqual(writeCheckpoint, -1);
  assert.ok(flagSet < writeCheckpoint);

  assert.match(
    source,
    /if \(!providerWriteStarted && isProviderReadTimeout\(error\)\) \{[\s\S]*?summary\.retryableBeforeWrite = true;[\s\S]*?\}[\s\S]*?finalizeRun\(run\.id, "FAILED"/,
  );
  assert.match(
    source,
    /summary\.inconclusiveReason === "PROVIDER_TIMEOUT"\) \{\s*summary\.retryableBeforeWrite = true;/,
  );
});

test("#435 Gate 3F scheduler keeps the 30 min stale window for RUNNING attempts", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(source, /const RETRY_AFTER_MS = 30 \* 60 \* 1000;/);
  assert.match(
    source,
    /function retryAfterMsFor\(status: TargetScheduleRunStatus\): number \{\s*return status === "FAILED" \? failedRetryAfterMs\(\) : RETRY_AFTER_MS;/,
  );
  assert.match(
    source,
    /scheduleStatus\(\s*generated\.status,\s*targetSummary,\s*generation\?\.summary,?\s*\)/,
  );
  // FAILED stays out of the terminal set; BLOCKED stays in it.
  assert.match(source, /TERMINAL_SCHEDULE_STATUSES[\s\S]*?"BLOCKED"/);
  assert.doesNotMatch(
    source,
    /TERMINAL_SCHEDULE_STATUSES =[^;]*"FAILED"/,
  );
});

test("#435 Gate 3H ambiguous write timeout keeps the slot retryable", () => {
  const ambiguous = { ambiguousWriteTimeout: true, writeOutcome: "UNKNOWN_TIMEOUT" };
  assert.equal(scheduleStatus("PARTIAL", ambiguous), "FAILED");
  assert.equal(scheduleStatus("FAILED", ambiguous), "FAILED");
  // Without the flag a failed apply stays terminal, as before.
  assert.equal(scheduleStatus("PARTIAL", { error: "HTTP 400" }), "PARTIAL");
  assert.equal(scheduleStatus("FAILED", { error: "HTTP 400" }), "BLOCKED");
  // A successful run is never downgraded.
  assert.equal(scheduleStatus("SUCCESS", ambiguous), "SUCCESS");
});

test("#435 Gate 3H recognizes only Spotify write timeouts as ambiguous", () => {
  const writeTimeout = new SpotifyApiError({
    kind: "WRITE_TIMEOUT",
    status: 0,
    method: "POST",
    operation: "playlist-write",
    reason: "WRITE_TIMEOUT",
    retryable: false,
    message: "timeout",
  });
  assert.equal(isSpotifyWriteTimeout(writeTimeout), true);
  assert.equal(isProviderReadTimeout(writeTimeout), false);
  assert.equal(
    isSpotifyWriteTimeout(
      new SpotifyApiError({
        kind: "READ_TIMEOUT",
        status: 0,
        method: "GET",
        operation: "playlist-items",
        retryable: true,
        message: "timeout",
      }),
    ),
    false,
  );
  assert.equal(isSpotifyWriteTimeout(new Error("timeout")), false);
});

test("#435 Gate 3H write deadline defaults to 30 s and is bounded", () => {
  assert.equal(DEFAULT_SPOTIFY_WRITE_TIMEOUT_MS, 30_000);
  assert.equal(spotifyWriteTimeoutMs(undefined), 30_000);
  assert.equal(spotifyWriteTimeoutMs("45000"), 45_000);
  assert.equal(spotifyWriteTimeoutMs("0"), 30_000);
  assert.equal(spotifyWriteTimeoutMs("999999"), 30_000);
  assert.equal(spotifyWriteTimeoutMs("abc"), 30_000);
});
