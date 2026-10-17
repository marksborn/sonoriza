import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  calculateAudiobookVirtualDuration,
  type AudiobookVirtualDurationInput,
} from "./virtual-chapter-duration";

const base: AudiobookVirtualDurationInput = {
  spotifyPlaylistId: "playlist-01",
  spotifyAudiobookId: "5E76EUAq7or1ncd4QNyHjI",
  selectedChapterId: "71PKNrJrxgaYwUY6srGQ3L",
  targetDurationMs: 300_000,
  chapterDurationMs: 20_039,
  // Illustrative ~15h22 entire book duration, not an authoritative Spotify field.
  providerDurationMs: 55_320_000,
  selection: { mode: "FULL_CHAPTER" },
};

function calculateWith(patch: Record<string, unknown> = {}) {
  return calculateAudiobookVirtualDuration(
    { ...base, ...patch } as AudiobookVirtualDurationInput,
  );
}

test("#489 Gate A: 1984 introduction occupies exactly 20,039 ms of a five-minute plan", () => {
  assert.deepEqual(calculateWith(), {
    status: "READY",
    spotifyPlaylistId: base.spotifyPlaylistId,
    spotifyAudiobookId: base.spotifyAudiobookId,
    selectedChapterId: base.selectedChapterId,
    planningMode: "FULL_CHAPTER",
    targetDurationMs: 300_000,
    providerDurationMs: 55_320_000,
    chapterDurationMs: 20_039,
    manualConsumedMs: 0,
    effectivePlanningDurationMs: 20_039,
    remainingPlanningDurationMs: 279_961,
    manualSpotifyControlRequired: true,
  });
});

test("#489 Gate A: entire-book duration never drives the planning budget", () => {
  const result = calculateWith({ providerDurationMs: 100_000_000 });
  assert.equal(result.status, "READY");
  if (result.status === "READY") {
    assert.equal(result.providerDurationMs, 100_000_000);
    assert.equal(result.effectivePlanningDurationMs, 20_039);
    assert.equal(result.remainingPlanningDurationMs, 279_961);
  }
  const withoutBookDuration = calculateWith({ providerDurationMs: null });
  assert.equal(withoutBookDuration.status, "READY");
  if (withoutBookDuration.status === "READY") {
    assert.equal(withoutBookDuration.providerDurationMs, null);
    assert.equal(withoutBookDuration.remainingPlanningDurationMs, 279_961);
  }
});

test("#489 Gate A: manual progress affects only the virtual chapter remainder", () => {
  assert.deepEqual(
    calculateWith({ selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 } }),
    {
      status: "READY",
      spotifyPlaylistId: base.spotifyPlaylistId,
      spotifyAudiobookId: base.spotifyAudiobookId,
      selectedChapterId: base.selectedChapterId,
      planningMode: "MANUAL_REMAINDER",
      targetDurationMs: 300_000,
      providerDurationMs: 55_320_000,
      chapterDurationMs: 20_039,
      manualConsumedMs: 10_000,
      effectivePlanningDurationMs: 10_039,
      remainingPlanningDurationMs: 289_961,
      manualSpotifyControlRequired: true,
    },
  );
});

test("#489 Gate A: explicit beginning and zero manually consumed produce the same budget", () => {
  const start = calculateWith();
  const manualZero = calculateWith({
    selection: { mode: "MANUAL_REMAINDER", consumedMs: 0 },
  });
  assert.equal(start.status, "READY");
  assert.equal(manualZero.status, "READY");
  if (start.status === "READY" && manualZero.status === "READY") {
    assert.equal(start.effectivePlanningDurationMs, manualZero.effectivePlanningDurationMs);
  }
});

test("#489 Gate A: an exact fit leaves zero remainder without truncation", () => {
  const value = calculateWith({ targetDurationMs: 20_039 });
  assert.equal(value.status, "READY");
  if (value.status === "READY") {
    assert.equal(value.remainingPlanningDurationMs, 0);
  }
});

test("#489 Gate A: overlong chapters block preview rather than subtracting a negative balance", () => {
  assert.deepEqual(calculateWith({ targetDurationMs: 20_038 }), {
    status: "BLOCKED",
    reason: "CHAPTER_EXCEEDS_TARGET",
  });
});

test("#489 Gate A: unknown, zero, non-integer and unsafe chapter durations block", () => {
  for (const chapterDurationMs of [
    undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY,
    20_039.5, Number.MAX_SAFE_INTEGER + 1, "20039",
  ]) {
    assert.deepEqual(calculateWith({ chapterDurationMs }), {
      status: "BLOCKED",
      reason: "INVALID_CHAPTER_DURATION",
    });
  }
});

test("#489 Gate A: malformed target duration blocks; no coercion or negative time", () => {
  for (const targetDurationMs of [
    undefined, null, 0, -1, Number.NaN, Number.NEGATIVE_INFINITY,
    300_000.5, Number.MAX_SAFE_INTEGER + 1, "300000",
  ]) {
    assert.deepEqual(calculateWith({ targetDurationMs }), {
      status: "BLOCKED",
      reason: "INVALID_TARGET_DURATION",
    });
  }
});

test("#489 Gate A: invalid provider duration does not fall back to book or chapter data", () => {
  for (const providerDurationMs of [0, -1, NaN, Infinity, "15h22", 1.25]) {
    assert.deepEqual(calculateWith({ providerDurationMs }), {
      status: "BLOCKED",
      reason: "INVALID_PROVIDER_DURATION",
    });
  }
});

test("#489 Gate A: selected chapter mode is explicit and conflicting progress blocks", () => {
  for (const selection of [
    undefined, null, "FULL_CHAPTER", {}, { mode: "UNKNOWN" },
    { mode: "FULL_CHAPTER", consumedMs: 5 },
    { mode: "FULL_CHAPTER", consumedMs: undefined },
  ]) {
    assert.deepEqual(calculateWith({ selection }), {
      status: "BLOCKED",
      reason: "INVALID_SELECTION",
    });
  }
});

test("#489 Gate A: manual remainder rejects unknown, negative or excessive progress", () => {
  for (const consumedMs of [undefined, null, -1, NaN, Infinity, 12.5, 20_040, "5000"]) {
    assert.deepEqual(
      calculateWith({ selection: { mode: "MANUAL_REMAINDER", consumedMs } }),
      { status: "BLOCKED", reason: "INVALID_MANUAL_PROGRESS" },
    );
  }
  assert.deepEqual(
    calculateWith({ selection: { mode: "MANUAL_REMAINDER", consumedMs: 20_039 } }),
    { status: "BLOCKED", reason: "CHAPTER_ALREADY_FINISHED" },
  );
});

test("#489 Gate A: no virtual duration without an explicit local identity", () => {
  assert.deepEqual(calculateWith({ spotifyPlaylistId: " " }), {
    status: "BLOCKED", reason: "MISSING_PLAYLIST_ID",
  });
  assert.deepEqual(calculateWith({ spotifyAudiobookId: null }), {
    status: "BLOCKED", reason: "MISSING_AUDIOBOOK_ID",
  });
  assert.deepEqual(calculateWith({ selectedChapterId: "" }), {
    status: "BLOCKED", reason: "MISSING_CHAPTER_ID",
  });
  assert.deepEqual(
    calculateAudiobookVirtualDuration(null as unknown as AudiobookVirtualDurationInput),
    { status: "BLOCKED", reason: "INVALID_INPUT" },
  );
});

test("#489 Gate A: pure calculation does not mutate input or import provider/writer code", () => {
  const frozen = Object.freeze({
    ...base,
    selection: Object.freeze({ mode: "FULL_CHAPTER" as const }),
  });
  assert.equal(calculateAudiobookVirtualDuration(frozen).status, "READY");
  assert.equal(frozen.chapterDurationMs, 20_039);
  const code = readFileSync("src/services/audiobooks/virtual-chapter-duration.ts", "utf8");
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\b(?:fetch|replacePlaylistItems|addItemsToPlaylist|prisma)\s*\(/);
});
