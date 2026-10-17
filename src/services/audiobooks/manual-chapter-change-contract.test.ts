import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AUDIOBOOK_CHAPTER_CHANGE_CONFIRMATION,
  audiobookChapterUpdateEnabled,
  parseManualChapterChangeRequest,
} from "./manual-chapter-change-contract";

const base = {
  targetPlaylistId: "target_cuid_123456",
  expectedRevision: 0,
  selectedChapterId: "71PKNrJrxgaYwUY6srGQ3L",
  selection: { mode: "FULL_CHAPTER" },
};

test("#489 Gate C: strictly parse read-only chapter preview", () => {
  assert.deepEqual(parseManualChapterChangeRequest(base, false), {
    ok: true, value: base,
  });
  assert.deepEqual(parseManualChapterChangeRequest({
    ...base, selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 },
  }, false), {
    ok: true, value: { ...base, selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 } },
  });
});

test("#489 Gate C: update requires explicit confirmation", () => {
  assert.deepEqual(parseManualChapterChangeRequest({ ...base }, true), {
    ok: false, code: "CHAPTER_CHANGE_CONFIRMATION_REQUIRED",
  });
  const body = { ...base, confirmation: AUDIOBOOK_CHAPTER_CHANGE_CONFIRMATION };
  assert.deepEqual(parseManualChapterChangeRequest(body, true), { ok: true, value: base });
  assert.deepEqual(parseManualChapterChangeRequest(body, false), {
    ok: false, code: "INVALID_BODY",
  });
});

test("#489 Gate C: forged remote book, playlist, duration and state cannot be injected", () => {
  for (const injection of [
    { spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP" },
    { spotifyAudiobookId: "5E76EUAq7or1ncd4QNyHjI" },
    { chapterDurationMs: 10 },
    { providerDurationMs: 10 },
    { previousChapterId: "old" },
    { userId: "other" },
    { revision: 999 },
  ]) {
    assert.deepEqual(parseManualChapterChangeRequest({ ...base, ...injection }, false), {
      ok: false, code: "INVALID_BODY",
    });
  }
});

test("#489 Gate C: reject corrupted revision and progress inputs", () => {
  for (const expectedRevision of [-1, 1.2, 1e18, "0", undefined, null]) {
    assert.deepEqual(parseManualChapterChangeRequest({ ...base, expectedRevision }, false), {
      ok: false, code: "INVALID_REVISION",
    });
  }
  for (const consumedMs of [-1, 0.1, Infinity, NaN, "1000", null, undefined, 2147483648]) {
    assert.equal(parseManualChapterChangeRequest({
      ...base, selection: { mode: "MANUAL_REMAINDER", consumedMs },
    }, false).ok, false);
  }
});

test("#489 Gate C: change activation requires three explicit ACTIVE flags", () => {
  const values = [undefined, "", "SHADOW", "ACTIVE"];
  for (const a of values) for (const b of values) for (const c of values) {
    const result = audiobookChapterUpdateEnabled({
      AUDIOBOOK02_CHAPTER_UPDATE_MODE: a,
      AUDIOBOOK02_BIND_MODE: b,
      AUDIOBOOK02_WRITE_FENCE_MODE: c,
    });
    assert.equal(result, a === "ACTIVE" && b === "ACTIVE" && c === "ACTIVE");
  }
});

test("#489 Gate C: UI and endpoints are gated, with no Spotify mutation", () => {
  const page = readFileSync("src/app/dashboard/configuracao/audiolivros/page.tsx", "utf8");
  const wizard = readFileSync("src/components/AudiobookChapterChangeEditor.tsx", "utf8");
  const preview = readFileSync("src/app/api/audiobooks/manual-chapter-preview/route.ts", "utf8");
  const update = readFileSync("src/app/api/audiobooks/manual-chapter-update/route.ts", "utf8");
  assert.match(page, /AUDIOBOOK02_BIND_UI_MODE/);
  assert.match(page, /audiobookChapterUpdateEnabled/);
  assert.match(wizard, /Confirmar novo capítulo local/);
  assert.match(wizard, //api/audiobooks/manual-chapter-preview/);
  assert.match(wizard, //api/audiobooks/manual-chapter-update/);
  assert.match(preview, /AUDIOBOOK02_BIND_UI_MODE/);
  assert.match(update, /audiobookChapterUpdateEnabled/);
  for (const content of [wizard, preview, update]) {
    assert.doesNotMatch(content, /PUT \/playlists|DELETE \/playlists|POST \/playlists/);
  }
});
