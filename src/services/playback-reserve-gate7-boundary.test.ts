import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const generator = readFileSync(
  "src/jobs/generate-playlists-playback-reserve.ts",
  "utf8",
);
const envExample = readFileSync(".env.example", "utf8");

test("Gate 7 stays target-allowlisted, simulation-gated and defers KEEP_FILLED", () => {
  assert.match(generator, /PLAYBACK_RESERVE_ACTIVE_TARGET_IDS/);
  assert.match(generator, /findReusablePlaybackReserveSimulationEvidence/);
  assert.match(generator, /PLAYBACK_RESERVE_SIMULATION_REQUIRED/);
  assert.match(generator, /DEFERRED_KEEP_FILLED_GATE8/);
  assert.match(generator, /appendPlaylistItems/);
  assert.match(generator, /generationPlanItemRole\.createMany/);
  assert.match(generator, /checkPodcastCompletionBeforeWrite/);

  assert.match(envExample, /PLAYBACK_RESERVE_RUNTIME_MODE="SHADOW"/);
  assert.match(envExample, /PLAYBACK_RESERVE_ACTIVE_TARGET_IDS=""/);
});
