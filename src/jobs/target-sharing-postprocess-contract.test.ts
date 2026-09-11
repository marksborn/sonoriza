import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#326 generator guards discovery postprocessing before authoritative final validation", () => {
  const source = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  assert.match(
    source,
    /const discoveryBaselinePlan = plan/,
  );

  assert.match(
    source,
    /guardTargetSharingPostprocess/,
  );

  assert.match(
    source,
    /ABSTAIN_DISCOVERY_KEEP_BASELINE/,
  );

  assert.match(
    source,
    /recordDiscoveryTargetSharingAbstention/,
  );

  assert.match(
    source,
    /const targetSharingViolations = findTargetSharingViolations/,
  );
});

test("#326 Gate 5H preserves PlanRunResult sharing metadata", () => {
  const gate5h = readFileSync(
    "src/services/music-discovery/planner-discovery-gate5h.ts",
    "utf8",
  );

  assert.match(
    gate5h,
    /const plan: PlanRunResult = \{\s*\.\.\.input\.baseline,/,
  );

  assert.match(
    gate5h,
    /function clonePlan[\s\S]*?return \{\s*\.\.\.plan,/,
  );

  const runtime = readFileSync(
    "src/jobs/discovery-runtime.ts",
    "utf8",
  );

  assert.match(
    runtime,
    /let workingPlan: PlanRunResult = \{\s*\.\.\.input\.baseline,/,
  );

  assert.match(
    runtime,
    /workingPlan = \{\s*\.\.\.workingPlan,/,
  );
});

test("#326 target-sharing conflicts do not change EXCLUSIVE semantics", () => {
  const source = readFileSync(
    "src/services/playlist-planner/target-sharing-postprocess-guard.ts",
    "utf8",
  );

  assert.match(
    source,
    /findTargetSharingViolations/,
  );

  assert.match(
    source,
    /baselineViolations\.length === 0/,
  );

  assert.doesNotMatch(
    source,
    /SHAREABLE.*EXCLUSIVE|EXCLUSIVE.*SHAREABLE/,
  );
});
