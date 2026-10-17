import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateQuota,
  playlistLinks,
  summarizeItems,
} from "./youtube-music-poc.mjs";

test("quota: 120 insertions fit and full rewrite exceeds default", () => {
  const onlyAdd = estimateQuota({ adds: 120 });
  const fullRewrite = estimateQuota({ adds: 120, removes: 120 });
  assert.equal(onlyAdd.totalUnits, 6_000);
  assert.equal(onlyAdd.exceedsDefaultGeneralQuota, false);
  assert.equal(fullRewrite.totalUnits, 12_000);
  assert.equal(fullRewrite.exceedsDefaultGeneralQuota, true);
});

test("quota: counts include private playlist creation and reads", () => {
  const result = estimateQuota({ creates: 1, adds: 5, reads: 2, moves: 1 });
  assert.equal(result.totalUnits, 352);
  assert.equal(result.writeUnits, 350);
});

test("quota: invalid or fractional estimates are rejected", () => {
  assert.throws(() => estimateQuota({ adds: -1 }), /non-negative integer/);
  assert.throws(() => estimateQuota({ removes: 1.5 }), /non-negative integer/);
  assert.throws(() => estimateQuota({ creates: "foo" }), /non-negative integer/);
});

test("playlist links use a single shared YouTube playlist identity", () => {
  const links = playlistLinks("PLxYz_123-test");
  assert.equal(links.youtube, "https://www.youtube.com/playlist?list=PLxYz_123-test");
  assert.equal(links.youtubeMusic, "https://music.youtube.com/playlist?list=PLxYz_123-test");
  assert.throws(() => playlistLinks("../bad"), /Invalid YouTube playlist ID/);
});

test("items are kept in API order without falsely asserting YouTube Music visibility", () => {
  const summary = summarizeItems([
    { id: "item-1", snippet: { position: 0, title: "Music A", resourceId: { videoId: "AAAAAAAAAAA" } } },
    { id: "item-2", snippet: { position: 1, title: "Podcast", resourceId: { videoId: "BBBBBBBBBBB" } } },
    { id: "item-3", snippet: { position: 2, title: "Music B", resourceId: { videoId: "CCCCCCCCCCC" } } },
  ]);
  assert.deepEqual(summary.map((x) => x.videoId), ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]);
  assert.deepEqual(summary.map((x) => x.position), [0, 1, 2]);
  assert.equal(summary[1].youtubeMusicVisibility, "NOT_VERIFIED");
  assert.equal(summary[1].playbackEligibility, "NOT_VERIFIED");
});

test("deleted or unavailable playlist items are not mistaken for playable tracks", () => {
  const [item] = summarizeItems([{ id: "gone", snippet: { title: "Deleted video", position: 3 } }]);
  assert.equal(item.videoId, null);
  assert.equal(item.playbackEligibility, "NOT_VERIFIED");
});
