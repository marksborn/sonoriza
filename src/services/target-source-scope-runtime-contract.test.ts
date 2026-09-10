import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#204 Gate 3 uses identical active source-scope path for simulation and real generation", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  assert.match(generator, /targetSourceScopeRuntime/);
  assert.match(generator, /mode:\s*"ACTIVE"/);
  assert.match(generator, /plannerInfluence:\s*true/);
  assert.match(generator, /sourceIdsByTargetId/);

  // There must be no `if (simulate)` controlling application of source scope.
  assert.doesNotMatch(
    generator,
    /if\s*\(\s*simulate\s*\)[\s\S]{0,250}sourceIdsByTargetId/,
  );
});

test("#204 Gate 3 reads only union of effective configured sources", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );

  assert.match(generator, /requiredSourceIds/);
  assert.match(
    generator,
    /globallyEnabledSources\.filter\([\s\S]*requiredSourceIds\.has\(source\.id\)/,
  );
});

test("#204 Gate 3 adds configured-source provenance at the reader boundary", () => {
  const reader = readFileSync(
    "src/services/spotify/incremental-reader.ts",
    "utf8",
  );

  assert.match(reader, /sourcePlaylistId:\s*source\.id/);
});
