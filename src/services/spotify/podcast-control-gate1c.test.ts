import assert from "node:assert/strict";
import test from "node:test";
import {
  PODCAST_CONTROL, controlEpisodeId, eligiblePodcastEpisode,
  eligibleEmptyControlPlaylist, summarizeControlItems,
} from "./podcast-control-gate1c";
import { GATE1C } from "./audiobook-playlist-gate1c";

const EPISODE_ID = "0zLhl3WsOCQHbe1BPTiHgr"; // synthetic test fixture, not an approved control episode
const EPISODE_URI = `spotify:episode:${EPISODE_ID}`;
const OWNER = "current-user";

test("episode ID parser accepts canonical Spotify episode identifiers only", () => {
  assert.equal(controlEpisodeId(EPISODE_URI), EPISODE_ID);
  assert.equal(controlEpisodeId(EPISODE_ID), EPISODE_ID);
  assert.equal(controlEpisodeId(`https://open.spotify.com/episode/${EPISODE_ID}?si=x`), EPISODE_ID);
  assert.equal(controlEpisodeId(`https://open.spotify.com/intl-pt/episode/${EPISODE_ID}`), EPISODE_ID);
  assert.equal(controlEpisodeId(`https://example.com/episode/${EPISODE_ID}`), null);
  assert.equal(controlEpisodeId(`http://open.spotify.com/episode/${EPISODE_ID}`), null);
  assert.equal(controlEpisodeId(`https://open.spotify.com/show/${EPISODE_ID}`), null);
  assert.equal(controlEpisodeId(`spotify:episode:${GATE1C.chapterId}`), null);
  assert.equal(controlEpisodeId(""), null);
});

test("episode must be true playable podcast episode with a show (not audiobook chapter)", () => {
  const base = {
    id: EPISODE_ID, uri: EPISODE_URI, type: "episode",
    is_playable: true, restrictions: null, name: "Control episode",
    show: { type: "show", id: "38bS44xjbVVZ3No3ByF1dJ" },
  };
  assert.equal(eligiblePodcastEpisode(base, EPISODE_ID), true);
  assert.equal(eligiblePodcastEpisode({ ...base, type: "chapter" }, EPISODE_ID), false);
  assert.equal(eligiblePodcastEpisode({ ...base, is_playable: false }, EPISODE_ID), false);
  assert.equal(eligiblePodcastEpisode({ ...base, show: null }, EPISODE_ID), false);
  assert.equal(eligiblePodcastEpisode({ ...base, show: { type: "audiobook" } }, EPISODE_ID), false);
  assert.equal(eligiblePodcastEpisode({ ...base, restrictions: { reason: "market" } }, EPISODE_ID), false);
  assert.equal(eligiblePodcastEpisode({ ...base, id: GATE1C.chapterId }, GATE1C.chapterId), false);
});

test("only known second private empty playlist may receive a control POST", () => {
  const p = {
    id: PODCAST_CONTROL.playlistId, name: PODCAST_CONTROL.playlistName,
    public: false, collaborative: false,
    owner: { id: OWNER }, items: { total: 0 }, snapshot_id: "s0",
  };
  assert.equal(eligibleEmptyControlPlaylist(p, OWNER), true);
  assert.equal(eligibleEmptyControlPlaylist({ ...p, id: "4kYizEAtQhFsrrwD3tFphP" }, OWNER), false);
  assert.equal(eligibleEmptyControlPlaylist({ ...p, name: GATE1C.playlistName }, OWNER), false);
  assert.equal(eligibleEmptyControlPlaylist({ ...p, public: true }, OWNER), false);
  assert.equal(eligibleEmptyControlPlaylist({ ...p, owner: { id: "someone-else" } }, OWNER), false);
  assert.equal(eligibleEmptyControlPlaylist({ ...p, collaborative: true }, OWNER), false);
  assert.equal(eligibleEmptyControlPlaylist({ ...p, items: { total: 1 } }, OWNER), false);
  assert.equal(eligibleEmptyControlPlaylist({ ...p, snapshot_id: null }, OWNER), false);
});

test("GET reconciliation distinguishes matching episode, opaque item, and empty", () => {
  assert.deepEqual(summarizeControlItems({ total: 0, items: [] }, EPISODE_URI), {
    total: 0, returned: 0, matched: false, opaque: false,
    firstType: null, firstUriMatches: false,
  });
  const matched = summarizeControlItems({ total: 1, items: [{
    item: { uri: EPISODE_URI, type: "episode" },
  }] }, EPISODE_URI);
  assert.equal(matched.matched, true);
  const oldApi = summarizeControlItems({ total: 1, items: [{
    track: { uri: EPISODE_URI, type: "episode" },
  }] }, EPISODE_URI);
  assert.equal(oldApi.matched, true);
  const opaque = summarizeControlItems({ total: 1, items: [{ item: null }] }, EPISODE_URI);
  assert.equal(opaque.matched, false);
  assert.equal(opaque.opaque, true);
});
