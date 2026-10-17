import assert from "node:assert/strict";
import test from "node:test";
import { GATE1E, episodeMetadata, showMetadata, compareEpisodeMetadata } from "./audiobook-gate1e-forensics";

const chapter = {
  id: GATE1E.chapterId, type: "episode",
  uri: GATE1E.chapterEpisodeUri, is_playable: true,
  show: {
    id: "08zD9TXZk3aBnZ2pXKdmhq", type: "show", media_type: "audio",
    available_markets: ["BR"], publisher: "Example",
  },
  duration_ms: 20039,
};
const podcast = {
  id: GATE1E.controlId, type: "episode",
  uri: GATE1E.controlEpisodeUri, is_playable: true,
  show: { id: "38bS44xjbVVZ3No3ByF1dJ", type: "show", media_type: "audio" },
  duration_ms: 1400000,
};

test("both episode-shaped items still have UNPROVEN playlist write compatibility", () => {
  const a = episodeMetadata(chapter, GATE1E.chapterId);
  const b = episodeMetadata(podcast, GATE1E.controlId);
  assert.equal(a.validId, true);
  assert.equal(a.validUri, true);
  assert.equal(a.type, "episode");
  assert.equal(a.showType, "show");
  assert.equal(a.showId, chapter.show.id);
  assert.equal(a.showAvailableMarketsCount, 1);
  assert.equal(a.durationMs, 20039);
  assert.equal(b.validId, true);
  assert.equal(b.validUri, true);
  assert.equal(compareEpisodeMetadata(a, b).bothResolveAsEpisode, true);
  assert.equal(compareEpisodeMetadata(a, b).bothPlayable, true);
  assert.equal(compareEpisodeMetadata(a, b).bothHaveShows, true);
  assert.equal(compareEpisodeMetadata(a, b).playlistWriteCompatibility, "NOT_PROVEN_BY_GET_ONLY");
});

test("missing episode show ID or malformed URI must not be called comparable", () => {
  const bad = episodeMetadata({ ...chapter,
    uri: "spotify:chapter:71PKNrJrxgaYwUY6srGQ3L", show: { type: "show" },
  }, GATE1E.chapterId);
  assert.equal(bad.validUri, false);
  assert.equal(bad.showId, null);
  assert.equal(compareEpisodeMetadata(bad, episodeMetadata(podcast, GATE1E.controlId))
    .bothResolveAsEpisode, false);
});

test("show metadata is sanitized and expected ID-bound", () => {
  const id = "08zD9TXZk3aBnZ2pXKdmhq";
  const show = showMetadata({
    id, type: "show", media_type: "audio",
    available_markets: ["BR", "US"],
    languages: ["pt"], episodes: { total: 35, href: "https://api.spotify.com/v1/shows/x/episodes" },
    publisher: "Private publisher name omitted",
  }, id);
  assert.equal(show.idMatches, true);
  assert.equal(show.availableMarketsCount, 2);
  assert.equal(show.episodesTotal, 35);
  assert.equal(show.episodesReferencePresent, true);
  assert.equal(show.publisherPresent, true);
  assert.equal("publisher" in show, false);
  assert.equal(showMetadata({ type: "show" }, id).idMatches, false);
});

test("Gate 1E live metadata: shared audio format does not prove playlist POST compatibility", () => {
  // From sanitized authenticated CloudPanel GET-only evidence, 16/10/2026.
  // No real Spotify requests in this unit test.
  const chapterLive = episodeMetadata({
    id: GATE1E.chapterId, uri: GATE1E.chapterEpisodeUri,
    type: "episode", is_playable: true, is_externally_hosted: false,
    duration_ms: 20039, show: {
      id: "08zD9TXZk3aBnZ2pXKdmhq", type: "show",
      media_type: "audio", explicit: false,
    },
    resume_point: { fully_played: false },
  }, GATE1E.chapterId);
  const controlLive = episodeMetadata({
    id: GATE1E.controlId, uri: GATE1E.controlEpisodeUri,
    type: "episode", is_playable: true, is_externally_hosted: false,
    duration_ms: 1361096, show: {
      id: "38bS44xjbVVZ3No3ByF1dJ", type: "show",
      media_type: "audio", explicit: false,
    },
    resume_point: { fully_played: false },
  }, GATE1E.controlId);
  const compared = compareEpisodeMetadata(chapterLive, controlLive);
  assert.equal(compared.bothResolveAsEpisode, true);
  assert.equal(compared.bothHaveShows, true);
  assert.equal(compared.bothPlayable, true);
  assert.equal(compared.sameExternalHostingFlag, true);
  assert.equal(compared.sameNestedShowMediaType, true);
  assert.equal(compared.sameShowId, false);
  assert.equal(compared.sameDurationMs, false);
  assert.equal(compared.playlistWriteCompatibility, "NOT_PROVEN_BY_GET_ONLY");
  assert.equal(chapterLive.showAvailableMarketsCount, null);
  assert.equal(controlLive.showAvailableMarketsCount, null);

  const bookShow = showMetadata({
    id: chapterLive.showId, type: "show", media_type: "audio",
    is_externally_hosted: false,
    episodes: { total: 35, href: "/fake" }, languages: ["pt"],
    explicit: false,
  }, chapterLive.showId!);
  const podcastShow = showMetadata({
    id: controlLive.showId, type: "show", media_type: "audio",
    is_externally_hosted: false,
    episodes: { total: 237, href: "/fake" }, languages: ["pt"],
    explicit: false,
  }, controlLive.showId!);
  assert.equal(bookShow.episodesTotal, 35);
  assert.equal(podcastShow.episodesTotal, 237);
  assert.equal(bookShow.availableMarketsCount, null);
  assert.equal(podcastShow.availableMarketsCount, null);
  assert.equal(bookShow.idMatches, true);
  assert.equal(podcastShow.idMatches, true);
});
