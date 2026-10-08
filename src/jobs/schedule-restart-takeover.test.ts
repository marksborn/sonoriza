import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { processMemorySnapshot } from "@/services/process-memory";

import { providerWriteNeverStarted } from "./schedule-retry-policy";

const checkpoint = (name: string) => `Checkpoint ${name}`;

test("#435 Gate 3G run that died before PROVIDER_WRITE_START is safe to take over", () => {
  assert.equal(
    providerWriteNeverStarted([
      checkpoint("RUN_CREATED"),
      checkpoint("CALENDAR_READ_START"),
      checkpoint("CALENDAR_READ_DONE"),
      checkpoint("SOURCE_READ_START"),
    ]),
    true,
  );
  assert.equal(
    providerWriteNeverStarted([
      checkpoint("RUN_CREATED"),
      checkpoint("PLAN_READY"),
      checkpoint("PREWRITE_START"),
      checkpoint("PREWRITE_DONE"),
    ]),
    true,
  );
});

test("#435 Gate 3G run that reached PROVIDER_WRITE_START keeps the stale window", () => {
  assert.equal(
    providerWriteNeverStarted([
      checkpoint("RUN_CREATED"),
      checkpoint("PREWRITE_DONE"),
      checkpoint("PROVIDER_WRITE_START"),
    ]),
    false,
  );
  assert.equal(
    providerWriteNeverStarted([
      checkpoint("RUN_CREATED"),
      checkpoint("PROVIDER_WRITE_START"),
      checkpoint("PROVIDER_WRITE_DONE"),
      checkpoint("PERSIST_ITEMS_START"),
    ]),
    false,
  );
});

test("#435 Gate 3G run without checkpoints is unknown, never safe", () => {
  assert.equal(providerWriteNeverStarted([]), false);
  // Non-checkpoint log lines do not count as instrumentation evidence.
  assert.equal(providerWriteNeverStarted(["Run failed: boom"]), false);
});

test("#435 Gate 3G every generation playlist mutation follows PROVIDER_WRITE_START", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const writeStart = source.indexOf('persistGenerationCheckpoint(run.id, "PROVIDER_WRITE_START"');
  assert.notEqual(writeStart, -1);

  const mutation =
    /ensureSpotifyPlaylist\(writer|\.(replacePlaylistItems|appendPlaylistItems|removePlaylistItems|addPlaylistItems|createPlaylist)\(/g;
  const callSites = [...source.matchAll(mutation)].map((match) => match.index ?? -1);
  assert.ok(callSites.length > 0);
  for (const index of callSites) {
    // ensureSpotifyPlaylist's own definition calls createPlaylist; it sits
    // after the generation body, so every call site must follow the checkpoint.
    assert.ok(index > writeStart, `mutation at offset ${index} precedes PROVIDER_WRITE_START`);
  }

  // No other generation module may mutate playlists outside that boundary.
  for (const file of readdirSync("src/jobs")) {
    if (!/^generate-playlists.*\.ts$/.test(file) || file.endsWith(".test.ts")) continue;
    if (file === "generate-playlists-incremental.ts") continue;
    const other = readFileSync(`src/jobs/${file}`, "utf8");
    assert.doesNotMatch(
      other,
      /\.(replacePlaylistItems|appendPlaylistItems|removePlaylistItems|addPlaylistItems|createPlaylist)\(/,
      `${file} mutates a Spotify playlist outside the checkpointed write boundary`,
    );
  }
});

test("#435 Gate 3G restart takeover consults persisted checkpoints of the linked run", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");

  assert.match(
    source,
    /const processRestartTakeover =[\s\S]*?attemptOwnedByPreviousProcess\(currentAttempt\.details\)[\s\S]*?!currentAttempt\.generationRun \|\|[\s\S]*?currentAttempt\.generationRun\.simulation === true \|\|[\s\S]*?providerWriteNeverStarted\(\s*currentAttempt\.generationRun\.logs\.map\(\(log\) => log\.message\),?\s*\)/,
  );
  assert.match(
    source,
    /async function readCurrentAttemptForRecovery[\s\S]*?logs: \{\s*where: \{ message: \{ startsWith: "Checkpoint " \} \},\s*select: \{ message: true \},/,
  );
});

test("#442 checkpoints record process memory", () => {
  const snapshot = processMemorySnapshot({
    rss: 600 * 1024 * 1024,
    heapUsed: 300 * 1024 * 1024 + 400_000,
    heapTotal: 350 * 1024 * 1024,
    external: 20 * 1024 * 1024,
    arrayBuffers: 0,
  });
  assert.deepEqual(snapshot, {
    rssMb: 600,
    heapUsedMb: 300,
    heapTotalMb: 350,
    externalMb: 20,
  });
  assert.ok(processMemorySnapshot().rssMb > 0);

  const generation = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  assert.match(
    generation,
    /message: `Checkpoint \$\{checkpoint\}`,[\s\S]*?memory: processMemorySnapshot\(\)/,
  );
  const scheduler = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  assert.match(
    scheduler,
    /details: runningAttemptDetails\(checkpoint, \{\s*\.\.\.processMemorySnapshot\(\),\s*\}\)/,
  );
});
