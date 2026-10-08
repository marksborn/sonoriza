import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#435 Gate 3E inline simulation cannot claim a scheduled attempt", () => {
  const incremental = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );
  const reserve = readFileSync(
    "src/jobs/generate-playlists-playback-reserve.ts",
    "utf8",
  );
  const scheduler = readFileSync(
    "src/jobs/scheduled-generation.ts",
    "utf8",
  );

  assert.match(
    incremental,
    /if \(!simulate\) \{[\s\S]*?await opts\.onGenerationRunCreated\?\.\(run\.id\);[\s\S]*?\}/,
  );
  assert.match(
    reserve,
    /\.\.\.withoutScheduledLifecycleHooks\(effectiveOpts\)[\s\S]*?trigger: "SIMULATION"[\s\S]*?simulate: true/,
  );
  assert.match(
    reserve,
    /delete simulationOpts\.onGenerationRunCreated;[\s\S]*?delete simulationOpts\.assertGenerationRunStillActive;/,
  );
  assert.match(
    scheduler,
    /generation\.trigger !== "SCHEDULED"[\s\S]*?generation\.simulation/,
  );
  assert.match(
    scheduler,
    /is not a real SCHEDULED run and cannot own scheduler attempt/,
  );
});

test("#435 Gate 3E process restart has an explicit persisted scheduler lease", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(
    source,
    /const SCHEDULER_INSTANCE_ID =[\s\S]*?NODE_APP_INSTANCE/,
  );
  assert.match(
    source,
    /const SCHEDULER_OWNER_ID =[\s\S]*?process\.pid[\s\S]*?randomUUID\(\)/,
  );
  assert.match(
    source,
    /schedulerOwnerId: SCHEDULER_OWNER_ID,[\s\S]*?schedulerInstanceId: SCHEDULER_INSTANCE_ID/,
  );
  assert.match(
    source,
    /details: runningAttemptDetails\("CLAIMED"\)/,
  );
  assert.match(
    source,
    /processRestartTakeover[\s\S]*?attemptOwnedByPreviousProcess\(currentAttempt\.details\)[\s\S]*?!currentAttempt\.generationRun[\s\S]*?currentAttempt\.generationRun\.simulation === true/,
  );
  assert.match(
    source,
    /!processRestartTakeover[\s\S]*?RETRY_AFTER_MS/,
  );
  assert.match(source, /PROCESS_RESTARTED_ATTEMPT_REASON/);
  assert.match(source, /PROCESS_RESTART_TERMINALIZED/);
});

test("#435 Gate 3E reconciles a completed real scheduled run before retrying", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  const reconcileCheck = source.indexOf(
    'currentAttempt.generationRun.trigger === "SCHEDULED"',
  );
  const maxAttemptsCheck = source.indexOf(
    "existing.attempt >=\n      MAX_SCHEDULE_ATTEMPTS",
  );
  const retryAgeCheck = source.indexOf("RETRY_AFTER_MS", reconcileCheck);

  assert.notEqual(reconcileCheck, -1);
  assert.notEqual(maxAttemptsCheck, -1);
  assert.notEqual(retryAgeCheck, -1);
  assert.ok(reconcileCheck < maxAttemptsCheck);
  assert.ok(reconcileCheck < retryAgeCheck);

  assert.match(
    source,
    /currentAttempt\.generationRun\.simulation === false[\s\S]*?currentAttempt\.generationRun\.status !== "RUNNING"[\s\S]*?reconcileCompletedScheduledAttempt/,
  );
  assert.match(
    source,
    /async function reconcileCompletedScheduledAttempt[\s\S]*?scheduleStatus\(generation\.status, targetSummary\)[\s\S]*?finishOne\(/,
  );
});

test("#435 Gate 3E PM2 memory guard keeps headroom above the observed generation peak", () => {
  const ecosystem = readFileSync("ecosystem.config.cjs", "utf8");

  assert.match(ecosystem, /instances: 1/);
  assert.match(ecosystem, /max_memory_restart: "768M"/);
  assert.doesNotMatch(ecosystem, /max_memory_restart: "512M"/);
});
