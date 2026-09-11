import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#204 Gate 4 shadow evidence remains available after Gate 5 activation", () => {
  const planner = readFileSync(
    "src/services/playlist-planner/plan-run.ts",
    "utf8",
  );
  const shadow = readFileSync(
    "src/services/playlist-planner/target-sharing-shadow.ts",
    "utf8",
  );

  // Gate 4 diagnostic projection is still produced by the planner.
  assert.match(planner, /targetSharingShadow/);
  assert.match(planner, /buildTargetSharingShadowEvidence/);

  // Its own contract remains explicitly non-authoritative.
  assert.match(shadow, /plannerInfluence:\s*false/);

  // Gate 5 is now authoritative.
  assert.match(planner, /targetSharingRuntime/);
  assert.match(planner, /gate:\s*5/);
  assert.match(planner, /mode:\s*"ACTIVE"/);
  assert.match(planner, /plannerInfluence:\s*true/);
});

test("#204 Gate 5 supersedes the legacy global reserved Set with owner-aware reservation", () => {
  const planner = readFileSync(
    "src/services/playlist-planner/plan-run.ts",
    "utf8",
  );

  assert.match(planner, /legacyHardReserved/);
  assert.match(planner, /cloneReservationMap/);
  assert.match(planner, /reservationsForTarget/);
  assert.match(planner, /addTargetReservations/);

  // The old run-global reservation mutation must no longer be authoritative.
  assert.doesNotMatch(planner, /reserved\.add\(uri\)/);
});

test("#204 Gate 4 uses persisted target override only for effective shadow policy", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  assert.match(
    generator,
    /resolveEffectiveSharingPolicy\([\s\S]{0,120}target\.sharingPolicy/,
  );
  assert.match(generator, /LEGACY_GLOBAL_SHARING_POLICY/);
});
