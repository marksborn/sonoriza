import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIOBOOK_BIND_CONFIRMATION,
  audiobookBindEnabled,
  manualAudiobookOriginAllowed,
  parseManualAudiobookBindRequest,
} from "./manual-bind-contract";

const base = {
  targetPlaylistId: "target_cuid_123456",
  spotifyAudiobookId: "5E76EUAq7or1ncd4QNyHjI",
  selectedChapterId: "71PKNrJrxgaYwUY6srGQ3L",
  selection: { mode: "FULL_CHAPTER" },
  confirmation: AUDIOBOOK_BIND_CONFIRMATION,
};

test("#489 B.3: explicit chapter-start binding parses canonical IDs only", () => {
  assert.deepEqual(parseManualAudiobookBindRequest(base), {
    ok: true,
    value: base,
  });
});

test("#489 B.3: no confirmation or forged remote item durations", () => {
  for (const raw of [
    { ...base, confirmation: "" },
    { ...base, confirmation: true },
    { ...base, confirmation: undefined },
  ]) assert.deepEqual(parseManualAudiobookBindRequest(raw), { ok: false, code: "EXPLICIT_CONFIRMATION_REQUIRED" });
});

test("#489 B.3: remote IDs must be valid Spotify identifiers", () => {
  for (const spotifyAudiobookId of ["", "fake", "spotify:audiobook:bad", "%20", "E".repeat(23)]) {
    assert.deepEqual(parseManualAudiobookBindRequest({ ...base, spotifyAudiobookId }), {
      ok: false, code: "INVALID_AUDIOBOOK_ID",
    });
  }
  for (const selectedChapterId of ["", null, "spotify:episode:bad", "7".repeat(10)]) {
    assert.deepEqual(parseManualAudiobookBindRequest({ ...base, selectedChapterId }), {
      ok: false, code: "INVALID_CHAPTER_ID",
    });
  }
});

test("#489 B.3: fabricated remote playlist ID or chapter duration cannot enter bind request", () => {
  for (const forged of [
    { spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP" },
    { chapterDurationMs: 20_039 },
    { providerDurationMs: 55_320_000 },
  ]) {
    assert.deepEqual(parseManualAudiobookBindRequest({ ...base, ...forged }), {
      ok: false, code: "INVALID_BODY",
    });
  }
});

test("#489 B.3: progress must be declared explicitly in milliseconds", () => {
  assert.deepEqual(
    parseManualAudiobookBindRequest({
      ...base,
      selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 },
    }),
    { ok: true, value: { ...base, selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 } } },
  );
  for (const consumedMs of [null, undefined, -1, NaN, 1.1, "10000", 2147483648]) {
    assert.deepEqual(parseManualAudiobookBindRequest({
      ...base,
      selection: { mode: "MANUAL_REMAINDER", consumedMs },
    }), { ok: false, code: "INVALID_MANUAL_PROGRESS" });
  }
});

test("#489 B.3: ambiguous or unrecognized chapter modes fail closed", () => {
  for (const selection of [
    null,
    {},
    { mode: "PODCAST" },
    { mode: "FULL_CHAPTER", consumedMs: 100 },
    { mode: "MANUAL_REMAINDER", consumedMs: 0, resumeFromSpotify: true },
  ]) assert.equal(parseManualAudiobookBindRequest({ ...base, selection }).ok, false);
});

test("#489 B.3: binder never activates unless BOTH switches are ACTIVE", () => {
  for (const [bind, fence, allowed] of [
    ["", "", false], ["ACTIVE", "", false], ["", "ACTIVE", false],
    ["SHADOW", "ACTIVE", false], ["ACTIVE", "SHADOW", false],
    ["ACTIVE", "ACTIVE", true],
  ] as const) assert.equal(audiobookBindEnabled({
    AUDIOBOOK02_BIND_MODE: bind,
    AUDIOBOOK02_WRITE_FENCE_MODE: fence,
  }), allowed);
});

test("#489 B.3: same-origin POST required, no permissive fallback", () => {
  assert.equal(manualAudiobookOriginAllowed("https://sonoriza.itsoft.com.br", "sonoriza.itsoft.com.br"), true);
  for (const origin of [
    null,
    "https://evil.example",
    "https://sonoriza.itsoft.com.br.evil.example",
    "https://sonoriza.itsoft.com.br@evil.example",
    "javascript:alert(1)",
    "https://sonoriza.itsoft.com.br/evil",
  ]) assert.equal(manualAudiobookOriginAllowed(origin, "sonoriza.itsoft.com.br"), false);
});
