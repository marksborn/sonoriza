import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#204 Gate 4 is wired as SHADOW with zero planner influence", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  assert.match(generator, /targetSharingShadow/);
  assert.match(generator, /gate:\s*4/);
  assert.match(generator, /mode:\s*"SHADOW"/);
  assert.match(generator, /plannerInfluence:\s*false/);
  assert.match(generator, /sharingPolicyByTargetId/);
});

test("#204 Gate 4 keeps the authoritative legacy reserved Set", () => {
  const planner = readFileSync(
    "src/services/playlist-planner/plan-run.ts",
    "utf8",
  );

  assert.match(
    planner,
    /const reserved = new Set<string>\(initialReserved \?\? \[\]\)/,
  );
  assert.match(planner, /reserved\.add\(uri\)/);

  // Gate 4 must not condition reservation on sharing policy.
  assert.doesNotMatch(
    planner,
    /if\s*\([^)]*SHAREABLE[^)]*\)[\s\S]{0,160}reserved\.add/,
  );
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
