import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = () => readFileSync("prisma/schema.prisma", "utf8");

test("#204 source scope has backward-compatible inheritance default", () => {
  const source = schema();

  assert.match(
    source,
    /enum TargetSourceScopeMode\s*\{\s*INHERIT_GLOBAL\s*SELECTED_ONLY\s*\}/s,
  );

  assert.match(
    source,
    /sourceScopeMode\s+TargetSourceScopeMode\s+@default\(INHERIT_GLOBAL\)/,
  );
});

test("#204 sharing policy starts by inheriting legacy behavior", () => {
  const source = schema();

  assert.match(
    source,
    /enum TargetSharingPolicy\s*\{\s*INHERIT_GLOBAL\s*EXCLUSIVE\s*SHAREABLE\s*\}/s,
  );

  assert.match(
    source,
    /sharingPolicy\s+TargetSharingPolicy\s+@default\(INHERIT_GLOBAL\)/,
  );
});

test("#204 target/source relation is explicit and user-scoped", () => {
  const source = schema();

  assert.match(source, /model TargetPlaylistSource\s*\{/);
  assert.match(source, /userId\s+String/);

  assert.match(
    source,
    /fields:\s*\[userId,\s*targetPlaylistId\][\s\S]*references:\s*\[userId,\s*id\]/,
  );

  assert.match(
    source,
    /fields:\s*\[userId,\s*sourcePlaylistId\][\s\S]*references:\s*\[userId,\s*id\]/,
  );

  assert.match(
    source,
    /@@id\(\[targetPlaylistId,\s*sourcePlaylistId\]\)/,
  );
});

test("#204 Gate 1 does not alter planner domain", () => {
  const plannerTypes = readFileSync(
    "src/services/playlist-planner/types.ts",
    "utf8",
  );

  assert.doesNotMatch(plannerTypes, /TargetSourceScopeMode/);
  assert.doesNotMatch(plannerTypes, /TargetSharingPolicy/);
  assert.doesNotMatch(plannerTypes, /TargetPlaylistSource/);
});
