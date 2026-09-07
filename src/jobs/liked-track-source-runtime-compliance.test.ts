import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  spotifySavedTracksPlannerCapability,
  spotifySavedTracksShadowCapability,
} from "@/services/data-policy";

test("Saved Tracks is approved for direct planner use while behavioral shadow remains blocked", () => {
  const shadow = spotifySavedTracksShadowCapability();
  const planner = spotifySavedTracksPlannerCapability();

  assert.equal(shadow.allowed, false);
  assert.equal(shadow.decisions.BEHAVIORAL_ANALYTICS, "DENY");

  assert.equal(planner.allowed, true);
  assert.equal(planner.decisions.OPERATIONAL_PLANNING, "ALLOW");
  assert.equal(planner.decisions.PLANNER_ELIGIBILITY, "ALLOW");
});

test("incremental runtime masks shadow and planner influence with their independent capabilities", () => {
  const source = readFileSync("src/jobs/incremental-planning.ts", "utf8");
  const shadowCapability = source.indexOf("spotifySavedTracksShadowCapability()");
  const plannerCapability = source.indexOf("spotifySavedTracksPlannerCapability()");
  const prepare = source.indexOf("await prepareLikedTrackSourceShadowForCurrentRun()");

  assert.ok(shadowCapability >= 0);
  assert.ok(plannerCapability > shadowCapability);
  assert.ok(prepare > plannerCapability);
  assert.match(
    source,
    /likedShadowCapability\.allowed\s*&&\s*preparedLikedTrackSource\.enabled/,
  );
  assert.match(
    source,
    /likedPlannerCapability\.allowed\s*&&\s*preparedLikedTrackSource\.plannerPilotEnabled\s*===\s*true/,
  );
  assert.match(source, /reason: "SOURCE_CAPABILITY_BLOCKED"/);
  assert.match(source, /dbReads: false/);
});
