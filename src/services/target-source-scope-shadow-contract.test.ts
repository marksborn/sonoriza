import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#204 Gate 2 resolver remains the authoritative source-scope projection after Gate 3 activation", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  assert.match(generator, /resolveTargetSourceScope/);
  assert.match(generator, /effectiveSourceIds/);

  // Gate 3 intentionally supersedes the old shadow-only boundary.
  assert.match(generator, /targetSourceScopeRuntime/);
  assert.match(generator, /mode:\s*"ACTIVE"/);
  assert.match(generator, /plannerInfluence:\s*true/);
  assert.match(generator, /sourceIdsByTargetId/);
});

test("#204 Gate 2 does not put source-scope persistence types in planner domain", () => {
  const plannerTypes = readFileSync(
    "src/services/playlist-planner/types.ts",
    "utf8",
  );

  assert.doesNotMatch(plannerTypes, /TargetSourceScopeMode/);
  assert.doesNotMatch(plannerTypes, /TargetPlaylistSource/);
});
