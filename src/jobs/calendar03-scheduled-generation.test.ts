import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schedulerSource = () =>
  readFileSync("src/jobs/scheduled-generation.ts", "utf8");

test("#308 scheduler uses the CALENDAR-03 decorated CONFIG-04 assessment", () => {
  const source = schedulerSource();

  assert.match(
    source,
    /const baseAssessment = await assessConfiguration\(user\.id\);/,
  );
  assert.match(
    source,
    /assessCalendar03GenerationConfiguration\(\s*user\.id,\s*baseAssessment,\s*\)/,
  );
  assert.match(
    source,
    /const assessment = calendar03Configuration\.assessment;/,
  );
  assert.match(
    source,
    /getFirstRunGate\(user\.id, assessment\)/,
  );
  assert.match(
    source,
    /findReusableSimulationMusicOrderEvidence\(\s*user\.id,\s*assessment\.fingerprint,\s*\)/,
  );
});

test("#308 each isolated scheduled target gets the canonical CALENDAR-03 runtime", () => {
  const source = schedulerSource();

  assert.match(source, /runIsolated\(\s*executable,/);
  assert.match(source, /targetPlaylistIds: \[targetId\]/);
  assert.match(
    source,
    /createCalendar03PlannerRuntimeState\(\{[\s\S]*?policies: calendar03Configuration\.policies,[\s\S]*?requestedMode: process\.env\.CALENDAR_03_PLANNER_MODE \?\? "SHADOW",[\s\S]*?userEmail: user\.email \?\? null,[\s\S]*?CALENDAR_03_PLANNER_EMAIL_ALLOWLIST[\s\S]*?CALENDAR_03_PLANNER_TARGET_IDS/,
  );
  assert.match(
    source,
    /runWithCalendar03PlannerRuntimeState\(\s*calendar03State,[\s\S]*?generatePlaylists\(\{/,
  );
});

test("#308 scheduled GenerationRun summary preserves engine evidence and adds canonical CALENDAR-03 evidence", () => {
  const source = schedulerSource();

  assert.match(
    source,
    /const existingSummary =[\s\S]*?generation\.summary as Record<string, unknown>[\s\S]*?: \{\};/,
  );
  assert.match(
    source,
    /summary: \{\s*\.\.\.existingSummary,\s*configurationFingerprint: assessment\.fingerprint,\s*calendar03PlannerRuntime:\s*calendar03PlannerRuntimeSummary\(calendar03State\),\s*\}/,
  );
  assert.match(
    source,
    /where: \{\s*id: generated\.runId,\s*userId: user\.id,\s*simulation: false,\s*\}/,
  );
});

test("#308 scheduler does not introduce a scheduler-specific ACTIVE shortcut", () => {
  const source = schedulerSource();

  assert.doesNotMatch(source, /effectiveMode\s*:/);
  assert.doesNotMatch(source, /activationReason\s*:/);
  assert.doesNotMatch(source, /ACTIVE_ALLOWED\s*:/);
  assert.match(source, /CALENDAR_03_PLANNER_MODE/);
  assert.match(source, /CALENDAR_03_PLANNER_EMAIL_ALLOWLIST/);
  assert.match(source, /CALENDAR_03_PLANNER_TARGET_IDS/);
});
