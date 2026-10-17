import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadAudiobookChapterList } from "./spotify-chapter-list";

const bookId = "5E76EUAq7or1ncd4QNyHjI";
function chapter(n: number, playable = true) {
  return {
    id: "a" + String(n).padStart(21, "0"),
    name: "Capítulo " + n,
    type: "episode",
    duration_ms: 20_039,
    is_playable: playable,
  };
}
function reader(total: number, invalid: "NONE" | "SHORT_PAGE" | "WRONG_OFFSET" = "NONE") {
  const requests: string[] = [];
  return {
    requests,
    read: async (path: string) => {
      requests.push(path);
      if (path === "/audiobooks/" + bookId)
        return { id: bookId, name: "1984", type: "audiobook" };
      const url = new URL(path, "https://api.spotify.com");
      const offset = Number(url.searchParams.get("offset"));
      const count = invalid === "SHORT_PAGE" && offset === 0 ? 3 :
        Math.max(0, Math.min(50, total - offset));
      return {
        offset: invalid === "WRONG_OFFSET" ? 99 : offset,
        total,
        items: Array.from({ length: count }, (_v, i) => chapter(offset + i)),
      };
    },
  };
}

test("#489 B.4: 35-chapter book lists all chapters without provider writes", async () => {
  const r = reader(35);
  const result = await loadAudiobookChapterList(bookId, r.read);
  assert.equal(result.audiobookName, "1984");
  assert.equal(result.chapters.length, 35);
  assert.equal(result.total, 35);
  assert.equal(result.truncated, false);
  assert.deepEqual(r.requests, [
    "/audiobooks/" + bookId,
    "/audiobooks/" + bookId + "/chapters?limit=50&offset=0",
  ]);
});

test("#489 B.4: pagination is capped and never guesses missing chapters", async () => {
  const r = reader(240);
  const result = await loadAudiobookChapterList(bookId, r.read);
  assert.equal(result.chapters.length, 200);
  assert.equal(result.total, 240);
  assert.equal(result.truncated, true);
  assert.equal(r.requests.length, 5);
  assert.ok(r.requests.every(path => !/playlist/.test(path)));
});

test("#489 B.4: malformed or incomplete catalogue fails closed", async () => {
  await assert.rejects(
    loadAudiobookChapterList("wrong", async () => { throw Error("called provider"); }),
    /AUDIOBOOK_CATALOG_INVALID_BOOK_ID/,
  );
  for (const invalid of ["SHORT_PAGE", "WRONG_OFFSET"] as const) {
    await assert.rejects(loadAudiobookChapterList(bookId, reader(70, invalid).read),
      /AUDIOBOOK_CATALOG_CHAPTERS_INCOMPLETE/);
  }
  await assert.rejects(loadAudiobookChapterList(bookId, async () => {
    throw Error("Spotify 403 unavailable market");
  }), /Spotify 403/);
});

test("#489 B.4: unusable chapters cannot be selected", async () => {
  const r = await loadAudiobookChapterList(bookId, async path => {
    if (path.startsWith("/audiobooks/") && !path.includes("/chapters?"))
      return { id: bookId, type: "audiobook", name: "1984" };
    return { total: 2, offset: 0, items: [chapter(1), chapter(2, false)] };
  });
  assert.deepEqual(r.chapters.map(x => x.playable), [true, false]);
});

test("#489 B.4: page, preview and catalogue stay gated while binding remains separate", () => {
  const files = [
    "src/app/dashboard/configuracao/audiolivros/page.tsx",
    "src/app/api/audiobooks/catalog/route.ts",
    "src/app/api/audiobooks/manual-preview/route.ts",
  ].map(path => readFileSync(path, "utf8"));
  for (const file of files) assert.match(file, /AUDIOBOOK02_BIND_UI_MODE/);
  const wizard = readFileSync("src/components/AudiobookManualBindWizard.tsx", "utf8");
  assert.match(wizard, /bindingEnabled/);
  assert.match(wizard, /confirmPresence/);
  assert.match(wizard, /confirmManual/);
  assert.match(wizard, /\/api\/audiobooks\/manual-preview/);
  assert.match(wizard, /\/api\/audiobooks\/manual-bind/);
  assert.match(wizard, /a troca de capítulos|mudança do capítulo|mudança de capítulos/);
});
