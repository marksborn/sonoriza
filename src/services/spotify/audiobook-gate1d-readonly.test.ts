import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE1D, contentShape, playlistIdentity, playlistItemsShape,
  gate1dHypothesis,
} from "./audiobook-gate1d-readonly";

test("chapter URI shares prefix with podcast, but type stays different", () => {
  const chapter = contentShape({
    id: GATE1D.chapterId, type: "chapter", uri: GATE1D.chapterUri,
    is_playable: true, audiobook: { id: GATE1D.bookId, type: "audiobook" },
  }, GATE1D.chapterId);
  assert.equal(chapter.idMatches, true);
  assert.equal(chapter.uriLooksLikeEpisode, true);
  assert.equal(chapter.hasAudiobook, true);
  assert.equal(chapter.audiobookIdMatches, true);
  assert.equal(chapter.type, "chapter");
  assert.equal(chapter.hasShow, false);

  const episode = contentShape({
    id: GATE1D.controlEpisodeId, type: "episode",
    uri: GATE1D.controlEpisodeUri, is_playable: true,
    show: { type: "show" },
  }, GATE1D.controlEpisodeId);
  assert.equal(episode.idMatches, true);
  assert.equal(episode.type, "episode");
  assert.equal(episode.showType, "show");
  assert.equal(episode.hasAudiobook, false);
  assert.equal(contentShape({}, GATE1D.chapterId).idMatches, false);
});

test("playlist status only trusts fixed IDs, names and owner", () => {
  const p = {
    id: GATE1D.secondPlaylistId, name: GATE1D.secondPlaylistName,
    owner: { id: "authorized" }, public: false, collaborative: false,
    items: { total: 1 },
  };
  const matched = playlistIdentity(p, "authorized", GATE1D.secondPlaylistId);
  assert.equal(matched.exactId, true);
  assert.equal(matched.exactName, true);
  assert.equal(matched.exactOwner, true);
  assert.equal(matched.detailsTotal, 1);
  assert.equal(matched.publicState, "false");
  assert.equal(playlistIdentity({ ...p, id: "unknown" }, "authorized", GATE1D.secondPlaylistId).exactId, false);
  assert.equal(playlistIdentity({ ...p, name: "wrong" }, "authorized", GATE1D.secondPlaylistId).exactName, false);
  assert.equal(playlistIdentity({ ...p, owner: { id: "wrong" } }, "authorized", GATE1D.secondPlaylistId).exactOwner, false);
  assert.equal(playlistIdentity(p, "authorized", "not-allowlisted").exactId, false);
});

test("playlist item inspection is metadata-only, including opaque audiobooks", () => {
  const withOpaque = playlistItemsShape({ total: 1, items: [{ item: null }] },
    GATE1D.chapterUri, GATE1D.controlEpisodeUri);
  assert.equal(withOpaque.total, 1);
  assert.equal(withOpaque.opaqueCount, 1);
  assert.deepEqual(withOpaque.types, [null]);
  assert.equal(withOpaque.chapterUriMatches, 0);
  const withControl = playlistItemsShape({
    total: 1, items: [{ item: { type: "episode", uri: GATE1D.controlEpisodeUri } }],
  }, GATE1D.chapterUri, GATE1D.controlEpisodeUri);
  assert.equal(withControl.controlEpisodeUriMatches, 1);
  assert.equal(withControl.opaqueCount, 0);
});

test("hypothesis classification never asserts playlist support", () => {
  assert.equal(gate1dHypothesis("chapter", 404, null, "episode"),
    "CHAPTER_CATALOG_OBJECT_NOT_RESOLVED_AS_ORDINARY_EPISODE");
  assert.equal(gate1dHypothesis("chapter", 200, "episode", "episode"),
    "BOTH_ENDPOINTS_RESOLVE_ID_BUT_PLAYLIST_COMPATIBILITY_UNPROVEN");
  assert.equal(gate1dHypothesis("chapter", 200, "chapter", "episode"),
    "EPISODES_ENDPOINT_RETURNED_CHAPTER_TYPE_NOT_EQUIVALENT_TO_EPISODE");
  assert.equal(gate1dHypothesis("episode", 200, "episode", "episode"),
    "INCONCLUSIVE_READ_ONLY_SHAPES");
});


test("live-observed audiobook chapter has dual endpoint representations with identical URI", () => {
  // Gate 1D, 16/10/2026, Brazil OAuth: sanitized observations, no API calls.
  const asChapter = contentShape({
    id: GATE1D.chapterId,
    uri: GATE1D.chapterUri,
    type: "chapter",
    is_playable: true,
    audiobook: { id: GATE1D.bookId, type: "audiobook" },
  }, GATE1D.chapterId);
  const asEpisode = contentShape({
    id: GATE1D.chapterId,
    uri: GATE1D.chapterUri,
    type: "episode",
    is_playable: true,
    show: { type: "show" },
  }, GATE1D.chapterId);
  assert.equal(asChapter.idMatches, true);
  assert.equal(asEpisode.idMatches, true);
  assert.equal(asChapter.uriMatches, true);
  assert.equal(asEpisode.uriMatches, true);
  assert.equal(asChapter.type, "chapter");
  assert.equal(asChapter.hasAudiobook, true);
  assert.equal(asChapter.hasShow, false);
  assert.equal(asEpisode.type, "episode");
  assert.equal(asEpisode.hasAudiobook, false);
  assert.equal(asEpisode.hasShow, true);
  assert.equal(asEpisode.showType, "show");
  assert.equal(gate1dHypothesis(asChapter.type, 200, asEpisode.type, "episode"),
    "BOTH_ENDPOINTS_RESOLVE_ID_BUT_PLAYLIST_COMPATIBILITY_UNPROVEN");
});

test("live-observed playlists: control episode persists, manually added full audiobook opaque", () => {
  const ordinaryControl = playlistItemsShape({
    total: 1,
    items: [{ item: { uri: GATE1D.controlEpisodeUri, type: "episode" } }],
  }, GATE1D.chapterUri, GATE1D.controlEpisodeUri);
  const manualBook = playlistItemsShape({
    total: 1, items: [{ item: null }],
  }, GATE1D.chapterUri, GATE1D.controlEpisodeUri);
  assert.equal(ordinaryControl.total, 1);
  assert.equal(ordinaryControl.controlEpisodeUriMatches, 1);
  assert.equal(ordinaryControl.opaqueCount, 0);
  assert.equal(manualBook.total, 1);
  assert.equal(manualBook.opaqueCount, 1);
  assert.equal(manualBook.chapterUriMatches, 0);
  // 0 observable chapter URIs does NOT imply the full book item is absent.
});
