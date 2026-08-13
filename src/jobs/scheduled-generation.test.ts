import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#92 scheduler isolates every claimed target in its own GenerationRun", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(source, /runIsolated\(\s*executable,/);
  assert.match(source, /targetPlaylistIds: \[targetId\]/);
  assert.doesNotMatch(source, /const targetPlaylistIds = executable\.map/);
  assert.match(source, /id: \{ notIn: \[targetId\] \}/);
});
