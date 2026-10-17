import assert from "node:assert/strict";
import test from "node:test";

import { assertSpotifyAudiobookChapterEvidence } from "./spotify-chapter-evidence";

const bookId = "5E76EUAq7or1ncd4QNyHjI";
const chapterId = "71PKNrJrxgaYwUY6srGQ3L";
const ids = { spotifyAudiobookId: bookId, selectedChapterId: chapterId };
const book = { id: bookId, type: "audiobook", name: "1984" };
const chapter = {
  id: chapterId,
  type: "episode",
  audiobook: { id: bookId, type: "audiobook" },
  name: "Apresentação",
  duration_ms: 20_039,
  is_playable: true,
};

function read(bookPayload: unknown, chapterPayload: unknown) {
  const requested: string[] = [];
  return {
    requested,
    fetch: async (path: string) => {
      requested.push(path);
      return path.startsWith("/audiobooks/") ? bookPayload : chapterPayload;
    },
  };
}

test("#489 B.3: evidence uses exact single-item GETs and rejects inferred duration", async () => {
  const reader = read(book, chapter);
  const result = await assertSpotifyAudiobookChapterEvidence(ids, reader.fetch);
  assert.deepEqual(result, {
    spotifyAudiobookId: bookId,
    selectedChapterId: chapterId,
    chapterDurationMs: 20_039,
    providerDurationMs: null,
    audiobookName: "1984",
    chapterName: "Apresentação",
  });
  assert.deepEqual(reader.requested.sort(), [
    `/audiobooks/${bookId}`,
    `/chapters/${chapterId}`,
  ]);
});

test("#489 B.3: never bind a chapter belonging to a different audiobook", async () => {
  await assert.rejects(
    assertSpotifyAudiobookChapterEvidence(ids, read(book, {
      ...chapter, audiobook: { id: "someOtherBook" },
    }).fetch),
    /AUDIOBOOK_BIND_BLOCKED_UNVERIFIED_CHAPTER/,
  );
});

test("#489 B.3: wrong book identity, wrong type, or no book name is rejected", async () => {
  for (const entry of [
    null,
    { ...book, id: "wrong" },
    { ...book, type: "playlist" },
    { ...book, name: "" },
  ]) {
    await assert.rejects(
      assertSpotifyAudiobookChapterEvidence(ids, read(entry, chapter).fetch),
      /AUDIOBOOK_BIND_BLOCKED_UNVERIFIED_BOOK/,
    );
  }
});

test("#489 B.3: absent, unknown, unplayable, restricted or zero-length chapter is rejected", async () => {
  for (const entry of [
    null,
    { ...chapter, id: "wrong" },
    { ...chapter, type: "track" },
    { ...chapter, name: null },
    { ...chapter, is_playable: false },
    { ...chapter, restrictions: { reason: "payment_required" } },
    { ...chapter, duration_ms: 0 },
    { ...chapter, duration_ms: null },
    { ...chapter, duration_ms: -1 },
    { ...chapter, duration_ms: 2.1 },
    { ...chapter, duration_ms: 2147483648 },
  ]) {
    await assert.rejects(
      assertSpotifyAudiobookChapterEvidence(ids, read(book, entry).fetch),
      /AUDIOBOOK_BIND_BLOCKED_UNVERIFIED_CHAPTER/,
    );
  }
});

test("#489 B.3: catalog failures fail closed, never guess chapter membership", async () => {
  await assert.rejects(
    assertSpotifyAudiobookChapterEvidence(ids, async () => {
      throw new Error("Spotify API returned 403");
    }),
    /Spotify API returned 403/,
  );
});
