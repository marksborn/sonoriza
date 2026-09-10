import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#204 Gate 2 is observability only and does not filter collectIncrementally sources", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  assert.match(
    generator,
    /const sources = configuredSources\.filter\([\s\S]*source\.enabled/,
  );

  assert.match(
    generator,
    /collectIncrementally\(\{[\s\S]*sources: sourceCursors/,
  );

  assert.match(
    generator,
    /targetSourceScopeShadow[\s\S]*plannerInfluence:\s*false/,
  );

  assert.doesNotMatch(
    generator,
    /collectIncrementally\(\{[\s\S]{0,300}effectiveSourceIds/,
  );
});

test("#204 Gate 2 does not put source-scope persistence types in planner domain", () => {
  const plannerTypes = readFileSync(
    "src/services/playlist-planner/types.ts",
    "utf8",
  );

  assert.doesNotMatch(plannerTypes, /TargetSourceScopeMode/);
  assert.doesNotMatch(plannerTypes, /TargetPlaylistSource/);
});
