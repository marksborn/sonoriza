import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#435 scheduler links the exact attempt from the GenerationRun creation hook", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(
    source,
    /onGenerationRunCreated:\s*\(generationRunId\)\s*=>\s*linkGenerationRun\(entry\.audit, generationRunId\)/,
  );
  assert.doesNotMatch(
    source,
    /linkGenerationRun\(entry\.audit, generated\.runId\)/,
  );
});

test("#435 early link preserves historical attempt evidence and aggregate fencing", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(
    source,
    /targetScheduleAttempt\.updateMany\([\s\S]*?targetScheduleRunId: audit\.id,[\s\S]*?attempt: audit\.attempt,[\s\S]*?data: \{ generationRunId \}/,
  );
  assert.match(
    source,
    /targetScheduleRun\.updateMany\([\s\S]*?id: audit\.id,[\s\S]*?status: "RUNNING",[\s\S]*?attempt: audit\.attempt,[\s\S]*?data: \{ generationRunId \}/,
  );
});

test("#435 lifecycle hook is protected by the generation try/catch before long-running work", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");

  const createIndex = source.indexOf("await prisma.generationRun.create");
  const tryIndex = source.indexOf("try {", createIndex);
  const hookIndex = source.indexOf("await opts.onGenerationRunCreated?.(run.id)", tryIndex);
  const firstLongWorkIndex = source.indexOf("await prisma.user.findUnique", hookIndex);

  assert.notEqual(createIndex, -1);
  assert.notEqual(tryIndex, -1);
  assert.notEqual(hookIndex, -1);
  assert.notEqual(firstLongWorkIndex, -1);
  assert.ok(createIndex < tryIndex);
  assert.ok(tryIndex < hookIndex);
  assert.ok(hookIndex < firstLongWorkIndex);
});


test("#435 Gate 3C stale retry terminalizes the linked GenerationRun and records evidence", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(
    source,
    /staleAttempt\?\.generationRunId[\s\S]*?generationRun\.updateMany\([\s\S]*?status: "RUNNING"[\s\S]*?status: "FAILED"[\s\S]*?error: retryReason/,
  );
  assert.match(
    source,
    /const retryReason = processRestartTakeover[\s\S]*?PROCESS_RESTARTED_ATTEMPT_REASON[\s\S]*?STALE_RUNNING_ATTEMPT_REASON/,
  );
  assert.match(
    source,
    /const terminalCheckpoint = processRestartTakeover[\s\S]*?"PROCESS_RESTART_TERMINALIZED"[\s\S]*?"STALE_TERMINALIZED"/,
  );
  assert.match(source, /message: `Checkpoint \$\{terminalCheckpoint\}`/);
  assert.match(source, /checkpoint: terminalCheckpoint/);
});

test("#435 Gate 3C scheduled writes are fenced to the still-owning attempt", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(
    source,
    /assertGenerationRunStillActive:\s*\(generationRunId\)\s*=>\s*assertAttemptOwnsGenerationRun\(entry\.audit, generationRunId\)/,
  );
  assert.match(
    source,
    /aggregate\?\.status === "RUNNING"[\s\S]*?aggregate\.attempt === audit\.attempt[\s\S]*?aggregate\.generationRunId === generationRunId/,
  );
  assert.match(
    source,
    /attempt\?\.status === "RUNNING"[\s\S]*?attempt\.generationRunId === generationRunId/,
  );
  assert.match(source, /provider write fenced/);
});


test("#435 Gate 3C checkpoints KEEP_FILLED preparation before the GenerationRun exists", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(source, /recordAttemptCheckpoint\(entry\.audit, "KEEP_FILLED_PREP_START"\)/);
  assert.match(source, /prepareKeepFilledTarget\([\s\S]*?recordAttemptCheckpoint\(entry\.audit, "KEEP_FILLED_PREP_DONE"\)/);
  assert.match(
    source,
    /targetScheduleAttempt\.updateMany\([\s\S]*?status: "RUNNING"[\s\S]*?details:[\s\S]*?checkpoint/,
  );
});
