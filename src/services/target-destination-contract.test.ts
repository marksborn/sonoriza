import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shared = () =>
  readFileSync(
    "src/services/target-destination.ts",
    "utf8",
  );

test("target destination conflict validation is user-scoped", () => {
  const source = shared();

  assert.match(
    source,
    /userId: input\.userId/,
  );

  assert.match(
    source,
    /SpotifySourceType\.PLAYLIST/,
  );

  assert.match(
    source,
    /source-conflict/,
  );

  assert.match(
    source,
    /target-conflict/,
  );
});
