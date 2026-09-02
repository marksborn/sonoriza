import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  spotifySavedTracksPlannerCapability,
  spotifySavedTracksShadowCapability,
} from "@/services/data-policy";

test("Saved Tracks has no current shadow or planner capability", () => {
  const shadow = spotifySavedTracksShadowCapability();
  const planner = spotifySavedTracksPlannerCapability();
  assert.equal(shadow.allowed, false);
  assert.equal(shadow.decisions.BEHAVIORAL_ANALYTICS, "DENY");
  assert.equal(planner.allowed, false);
  assert.equal(planner.decisions.OPERATIONAL_PLANNING, "REVIEW_REQUIRED");
  assert.equal(planner.decisions.PLANNER_ELIGIBILITY, "REVIEW_REQUIRED");
});

test("incremental runtime checks capability before SOURCE-LIKED preparation", () => {
  const source = readFileSync("src/jobs/incremental-planning.ts", "utf8");
  const capability = source.indexOf("spotifySavedTracksShadowCapability()");
  const prepare = source.indexOf("await prepareLikedTrackSourceShadowForCurrentRun()");
  assert.ok(capability >= 0);
  assert.ok(prepare > capability);
  assert.match(source, /likedRuntimeAllowed\s*\?\s*await prepareLikedTrackSourceShadowForCurrentRun\(\)/);
  assert.match(source, /reason: "SOURCE_CAPABILITY_BLOCKED"/);
  assert.match(source, /dbReads: false/);
});
