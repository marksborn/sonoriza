import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#92 scheduler isolates every claimed target in its own GenerationRun", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(source, /runIsolated\(\s*executable,/);
  assert.match(source, /targetPlaylistIds: \[targetId\]/);
  assert.doesNotMatch(source, /const targetPlaylistIds = executable\.map/);
  assert.match(source, /id: \{ notIn: \[targetId\] \}/);
});

test("#226 scheduler creates one immutable audit row for every claimed attempt", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20260828135000_target_schedule_attempt_audit/migration.sql",
    "utf8",
  );

  assert.match(schema, /model TargetScheduleAttempt \{/);
  assert.match(schema, /@@unique\(\[targetScheduleRunId, attempt\]\)/);
  assert.match(source, /targetScheduleAttempt\.create\(/);
  assert.match(source, /attempt: existing\.attempt \+ 1/);
  assert.match(source, /attempt: audit\.attempt,/);
  assert.match(migration, /CREATE TABLE "TargetScheduleAttempt"/);
  assert.match(migration, /Historical retries that were already overwritten cannot be reconstructed/);
  assert.match(migration, /'legacy-' \|\| "id" \|\| '-' \|\| "attempt"::text/);
});

test("#226 stale RUNNING attempts are terminalized before a retry is claimed", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(source, /existing\.status === "RUNNING"/);
  assert.match(source, /STALE_RUNNING_ATTEMPT_REASON/);
  assert.match(
    source,
    /targetScheduleAttempt\.updateMany\([\s\S]*?status: "FAILED"[\s\S]*?finishedAt: now/,
  );
});

test("#226 terminal writes are fenced to the exact claimed attempt", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(source, /type ScheduleAttemptRef = Pick<TargetScheduleRun, "id" \| "attempt">/);
  assert.match(
    source,
    /targetScheduleRun\.updateMany\([\s\S]*?status: "RUNNING",[\s\S]*?attempt: audit\.attempt/,
  );
  assert.match(
    source,
    /onGenerationRunCreated:\s*\(generationRunId\)\s*=>\s*linkGenerationRun\(entry\.audit, generationRunId\)/,
  );
  assert.match(source, /Missing TargetScheduleAttempt .* while finishing/);
});

test("preflight GET 5xx becomes retryable FAILED before GenerationRun is created", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  assert.match(source, /await prepareKeepFilledTarget\(\s*user\.id, entry\.target, now,/);
  assert.match(
    source,
    /catch \(error\) \{\s*const reason = errorMessage\(error\);\s*\/\/ KEEP_FILLED preparation[\s\S]*?isRetryableScheduledPreflightReadFailure\(error\)[\s\S]*?\? "FAILED"\s*:\s*"BLOCKED"/,
  );
  assert.match(source, /finishOne\(entry\.audit, status, reason, new Date\(\)\)/);
  assert.match(source, /const MAX_SCHEDULE_ATTEMPTS = 3/);
  assert.match(source, /return status === "FAILED" \? failedRetryAfterMs\(\) : RETRY_AFTER_MS/);
});

test("#324 BLOCKED is terminal for the same scheduled slot", () => {
  const source = readFileSync(
    "src/jobs/scheduled-generation.ts",
    "utf8",
  );

  assert.match(
    source,
    /TERMINAL_SCHEDULE_STATUSES[\s\S]*?"BLOCKED"/,
  );

  assert.match(
    source,
    /TERMINAL_SCHEDULE_STATUSES\.has\([\s\S]*?existing\.status/,
  );
});

test("#324 scheduled retries are capped at three total attempts", () => {
  const source = readFileSync(
    "src/jobs/scheduled-generation.ts",
    "utf8",
  );

  assert.match(
    source,
    /MAX_SCHEDULE_ATTEMPTS = 3/,
  );

  assert.match(
    source,
    /existing\.attempt >=[\s\S]*?MAX_SCHEDULE_ATTEMPTS/,
  );
});

test("#324 active Spotify backoff stops remaining isolated targets locally", () => {
  const source = readFileSync(
    "src/jobs/scheduled-generation.ts",
    "utf8",
  );

  assert.match(
    source,
    /getActiveSpotifyBackoff/,
  );

  assert.match(
    source,
    /const spotifyBackoff =[\s\S]*?await getActiveSpotifyBackoff\(\)/,
  );

  assert.match(
    source,
    /if \(spotifyBackoff\)[\s\S]*?finishOne\([\s\S]*?"BLOCKED"/,
  );

  assert.match(
    source,
    /sem novas chamadas ao provedor/,
  );
});

test("PODCAST-09 Gate 3.2 reuses the existing REBUILD_DAILY target-state read", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(
    source,
    /const before = await maintenanceSpotify\.getTargetPlaylistState\([\s\S]*?podcast09DestinationEpisodeIds\(before\.items\)/,
  );
  assert.match(
    source,
    /currentDestinationEpisodeIdsByTargetId\[targetId\] !== undefined[\s\S]*?currentDestinationEpisodeIdsByTargetId:/,
  );
  assert.doesNotMatch(
    source,
    /PODCAST_09[\s\S]*?getTargetPlaylistState/,
  );
});

test("#521 scheduled Spotify preflight metrics survive before and after GenerationRun", () => {
  const scheduler = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  const keepFilled = readFileSync("src/services/keep-filled-maintenance.ts", "utf8");

  assert.match(keepFilled, /onSpotifyClient\?\.\(spotify\)/);
  assert.match(scheduler, /recordAttemptSpotifyPreflightSafely\(/);
  assert.match(scheduler, /summarizeScheduledSpotifyPreflight\(/);
  assert.match(scheduler, /phase: "KEEP_FILLED"/);
  assert.match(scheduler, /phase: "REBUILD"/);
  assert.match(scheduler, /preserveScheduledSpotifyPreflight\(/);
  assert.match(scheduler, /targetScheduleAttempt\.updateMany\(/);
});
