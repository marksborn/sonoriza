import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE1C, chapterEligible, playlistOwnedPrivate, containsChapter, safeId,
} from "./audiobook-playlist-gate1c";

const owner = "spotify-user";

test("playlist policy is private, owned, named, non-collaborative", () => {
  const example = { id: "a".repeat(22), owner: { id: owner },
    name: GATE1C.playlistName, public: false, collaborative: false };
  assert.equal(playlistOwnedPrivate(example, owner), true);
  assert.equal(playlistOwnedPrivate({ ...example, public: true }, owner), false);
  assert.equal(playlistOwnedPrivate({ ...example, public: null }, owner), false);
  assert.equal(playlistOwnedPrivate({ ...example, owner: { id: "other" } }, owner), false);
  assert.equal(playlistOwnedPrivate({ ...example, collaborative: true }, owner), false);
  assert.equal(playlistOwnedPrivate({ ...example, name: "existing playlist" }, owner), false);
  assert.equal(safeId("bad"), null);
});

test("second playlist remains distinct from the manually created first one", () => {
  assert.notEqual(GATE1C.secondPrivatePlaylistName, GATE1C.playlistName);
  const candidate = { id: "a".repeat(22), owner: { id: owner },
    name: GATE1C.secondPrivatePlaylistName, public: false, collaborative: false };
  assert.equal(playlistOwnedPrivate(candidate, owner, GATE1C.secondPrivatePlaylistName), true);
  assert.equal(playlistOwnedPrivate({ ...candidate, name: GATE1C.playlistName }, owner, GATE1C.secondPrivatePlaylistName), false);
  assert.equal(playlistOwnedPrivate({ ...candidate, public: true }, owner, GATE1C.secondPrivatePlaylistName), false);
});

test("only confirmed chapter and allowed restrictions can progress to write", () => {
  const chapter = {
    id: GATE1C.chapterId, uri: GATE1C.chapterUri, type: "chapter",
    is_playable: true, restrictions: null,
  };
  assert.equal(chapterEligible(chapter), true);
  assert.equal(chapterEligible({ ...chapter, is_playable: false }), false);
  assert.equal(chapterEligible({ ...chapter, uri: "spotify:episode:other" }), false);
  assert.equal(chapterEligible({ ...chapter, restrictions: { reason: "market" } }), false);
  assert.equal(chapterEligible({ ...chapter, restrictions: { reason: "payment_required" } }), false);
});

test("playlist re-read distinguishes confirmed inclusion from successful POST", () => {
  assert.deepEqual(containsChapter({ total: 0, items: [] }), {
    total: 0, chapterFound: false, firstItemUri: null, firstItemType: null,
  });
  const state = containsChapter({ total: 1, items: [
    { item: { uri: GATE1C.chapterUri, type: "chapter" } },
  ] });
  assert.equal(state.chapterFound, true);
  assert.equal(state.firstItemUri, GATE1C.chapterUri);
  assert.equal(state.firstItemType, "chapter");
  assert.equal(containsChapter({ total: 1, items: [{ item: null }] }).chapterFound, false);
  assert.equal(containsChapter({ total: 1, items: [{ item: { uri: "spotify:track:x" } }] }).chapterFound, false);
});
