import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#435 Gate 3C persists phase checkpoints before long-running boundaries", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");

  for (const checkpoint of [
    "RUN_CREATED",
    "CALENDAR_READ_START",
    "CALENDAR_READ_DONE",
    "SOURCE_READ_START",
    "SOURCE_READ_DONE",
    "PLAN_READY",
    "PREWRITE_START",
    "PREWRITE_DONE",
    "PROVIDER_WRITE_START",
    "PROVIDER_WRITE_DONE",
    "PERSIST_ITEMS_START",
    "PERSIST_ITEMS_DONE",
  ]) {
    assert.match(source, new RegExp(`persistGenerationCheckpoint\\([\\s\\S]*?"${checkpoint}"`));
  }
});

test("#435 Gate 3C fences each Spotify mutation and refuses terminal GenerationRuns", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");

  assert.match(
    source,
    /assertGenerationRunWritable\([\s\S]*?replacePlaylistItems/,
  );
  assert.match(
    source,
    /assertGenerationRunWritable\([\s\S]*?appendPlaylistItems/,
  );
  assert.match(
    source,
    /assertGenerationRunWritable\([\s\S]*?removePlaylistItems/,
  );
  assert.match(
    source,
    /status !== "RUNNING"[\s\S]*?before provider write/,
  );
});

test("#435 Gate 3C late completion cannot overwrite a stale terminal result", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");

  assert.match(
    source,
    /generationRun\.updateMany\([\s\S]*?id: runId,[\s\S]*?status: "RUNNING"/,
  );
  assert.match(
    source,
    /if \(terminalized\.count !== 1\) return;/,
  );
  assert.doesNotMatch(
    source,
    /generationRun\.update\(\{[\s\S]*?where: \{ id: runId \}/,
  );
});
