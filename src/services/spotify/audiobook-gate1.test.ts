import assert from "node:assert/strict";
import test from "node:test";
import { catalogIdentity, chapterIdentity, firstChapter } from "./audiobook-gate1";

test("confirms an audiobook only from a matching API object type", () => {
  const result = catalogIdentity({
    type: "audiobook",
    id: "a".repeat(22),
    name: "Livro de teste",
    total_chapters: 7,
    external_urls: { spotify: "https://open.spotify.com/audiobook/test" },
  }, "audiobook");
  assert.equal(result.recognized, true);
  assert.equal(result.totalChapters, 7);
  assert.equal(result.apiType, "audiobook");
});

test("a /show URL does not make a show API response into an audiobook", () => {
  const result = catalogIdentity({
    type: "show",
    id: "b".repeat(22),
    name: "Show de teste",
  }, "audiobook");
  assert.equal(result.recognized, false);
  assert.equal(result.apiType, "show");
  assert.equal(result.totalChapters, null);
});

test("a chapter may have type=episode without being treated as a podcast", () => {
  const page = firstChapter({
    total: 16,
    items: [{
      id: "c".repeat(22),
      type: "episode",
      uri: `spotify:episode:${"c".repeat(22)}`,
      chapter_number: 4,
      duration_ms: 120_000,
      is_playable: true,
      resume_point: { resume_position_ms: 42_000, fully_played: false },
    }],
  });
  assert.equal(page.pageCount, 1);
  assert.equal(page.total, 16);
  assert.equal(page.chapter?.apiType, "episode");
  assert.equal(page.chapter?.chapterNumber, 4);
  assert.equal(page.chapter?.hasResumePoint, true);
  // Deliberate privacy safeguard: never emit the user's actual playback position.
  assert.equal(Object.hasOwn(page.chapter ?? {}, "resumePositionMs"), false);
});

test("missing/invalid metadata stays unknown rather than inventing values", () => {
  const value = chapterIdentity({
    duration_ms: -1,
    is_playable: "yes",
    restrictions: { reason: "market" },
  });
  assert.equal(value.durationMs, null);
  assert.equal(value.isPlayable, null);
  assert.equal(value.restriction, "market");
  assert.equal(value.hasResumePoint, false);
  assert.equal(firstChapter({ items: [] }).chapter, null);
});
