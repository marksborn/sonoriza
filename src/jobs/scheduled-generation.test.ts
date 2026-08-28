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
  assert.match(source, /linkGenerationRun\(entry\.audit, generated\.runId\)/);
  assert.match(source, /Missing TargetScheduleAttempt .* while finishing/);
});
