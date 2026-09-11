import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shared = () =>
  readFileSync(
    "src/services/music-playback-policy.ts",
    "utf8",
  );

test("music repeat persistence validates and scopes by user", () => {
  const source = shared();

  assert.match(
    source,
    /normalizeMusicPlaybackPolicyInput/,
  );

  assert.match(
    source,
    /prisma\.musicPlaybackPolicy\.upsert/,
  );

  assert.match(
    source,
    /where: \{ userId \}/,
  );
});
