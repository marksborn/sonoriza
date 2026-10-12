import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isScheduledCalendarNoop } from "./scheduled-calendar-noop";

const scheduledKeep = {
  trigger: "SCHEDULED" as const,
  simulate: false,
  requestedTargetIds: ["carro"],
  resolvedTargetIds: ["carro"],
  activeTargetIds: [],
  calendarSkippedTargetIds: ["carro"],
};

test("#442 scheduled calendar KEEP/SKIP with one skipped target avoids source reads", () => {
  assert.equal(isScheduledCalendarNoop(scheduledKeep), true);
  // The guard is intentionally policy-agnostic: the caller adds only calendar
  // KEEP/SKIP targets to calendarSkippedTargetIds; CLEAR stays active.
  assert.equal(
    isScheduledCalendarNoop({ ...scheduledKeep, activeTargetIds: ["carro"], calendarSkippedTargetIds: [] }),
    false,
  );
});

test("#442 does not fast-path simulation, manual, or unscoped runs", () => {
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, simulate: true }), false);
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, trigger: "MANUAL" }), false);
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, trigger: "SIMULATION" }), false);
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, requestedTargetIds: null }), false);
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, requestedTargetIds: [] }), false);
});

test("#442 never skips a run with active/multiple/mismatched destinations", () => {
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, activeTargetIds: ["carro"] }), false);
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, calendarSkippedTargetIds: [] }), false);
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, resolvedTargetIds: [] }), false);
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, resolvedTargetIds: ["outro"] }), false);
  assert.equal(isScheduledCalendarNoop({ ...scheduledKeep, calendarSkippedTargetIds: ["outro"] }), false);
  assert.equal(
    isScheduledCalendarNoop({
      ...scheduledKeep,
      requestedTargetIds: ["carro", "outro"],
      resolvedTargetIds: ["carro", "outro"],
      calendarSkippedTargetIds: ["carro", "outro"],
    }),
    false,
  );
});

test("#442 source-read fast path is after calendar check and preserves run audit", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const calendarDone = source.indexOf('await persistGenerationCheckpoint(run.id, "CALENDAR_READ_DONE"');
  const fastPath = source.indexOf("if (isScheduledCalendarNoop(");
  const sourceRead = source.indexOf('await persistGenerationCheckpoint(run.id, "SOURCE_READ_START"');
  assert.ok(calendarDone !== -1 && fastPath > calendarDone && sourceRead > fastPath);
  assert.match(
    source,
    /if \(isScheduledCalendarNoop\([\s\S]*?await persistGenerationCheckpoint\(run\.id, "CALENDAR_NO_ELIGIBLE_TARGETS"/,
  );
  assert.match(
    source,
    /"CALENDAR_NO_ELIGIBLE_TARGETS"[\s\S]*?await finalizeRun\(run\.id, "SUCCESS", logs, summary\);[\s\S]*?return \{ runId: run\.id, status: "SUCCESS" \};/,
  );
  assert.match(source, /summary\.calendarSkippedTargets = skipped\.map\(\(target\) =>/);
  assert.match(source, /summary\.skipped = skipped\.map\(\(target\) => target\.name\)/);
});
