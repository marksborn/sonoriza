import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeForYouRecommendations,
  getForYouExternalDiscoveryLimits,
  forYouReasonTexts,
  forYouStrengthLabel,
  type ForYouRecommendation,
} from "./for-you-report";

function recommendation(
  overrides: Partial<ForYouRecommendation> = {},
): ForYouRecommendation {
  return {
    key: "FAMILIAR:track-1",
    category: "FAMILIAR",
    artistName: "Artist",
    trackName: "Track",
    albumName: "Album",
    spotifyTrackId: "track-1",
    score: 82,
    reasonCodes: ["HIGH_HISTORICAL_AFFINITY", "RECENT_INTEREST"],
    provenance: "LISTENING_HISTORY",
    playCount: 20,
    plays30d: 3,
    lastPlayedAt: new Date("2026-01-01T00:00:00.000Z"),
    seedArtistName: null,
    seedTrackName: null,
    ...overrides,
  };
}

test("forYouReasonTexts translates DISCOVERY reasons to product language", () => {
  assert.deepEqual(forYouReasonTexts(recommendation()), [
    "Você tem afinidade histórica forte com este artista.",
    "Seu interesse por este artista está recente.",
  ]);
});

test("forYouReasonTexts explains external provenance without exposing score internals", () => {
  const result = forYouReasonTexts(
    recommendation({
      category: "DESCOBERTA",
      provenance: "LASTFM_SIMILAR_TRACK",
      spotifyTrackId: null,
      reasonCodes: ["HIGH_SIMILARITY"],
      seedArtistName: "Seed Artist",
      seedTrackName: "Seed Track",
    }),
    3,
  );

  assert.deepEqual(result, [
    "A similaridade com referências do seu perfil é alta.",
    "Relacionada a Seed Artist — Seed Track.",
  ]);
});

test("forYouStrengthLabel keeps score presentation simple", () => {
  assert.equal(forYouStrengthLabel(85), "Afinidade alta");
  assert.equal(forYouStrengthLabel(70), "Boa compatibilidade");
  assert.equal(forYouStrengthLabel(55), "Vale explorar");
});

test("dedupeForYouRecommendations keeps one visible recording label and backfills the limit", () => {
  const result = dedupeForYouRecommendations(
    [
      recommendation({
        key: "FAMILIAR:release-a",
        artistName: "Mushroomhead",
        trackName: "Sun Doesn't Rise",
        spotifyTrackId: "release-a",
        score: 80.9,
      }),
      recommendation({
        key: "FAMILIAR:release-b",
        artistName: " mushroomhead ",
        trackName: "  Sun Doesn't Rise ",
        spotifyTrackId: "release-b",
        score: 75.2,
      }),
      recommendation({
        key: "FAMILIAR:track-3",
        artistName: "In Flames",
        trackName: "Versus Terminus",
        spotifyTrackId: "track-3",
        score: 74.2,
      }),
    ],
    2,
  );

  assert.deepEqual(
    result.map((row) => row.spotifyTrackId),
    ["release-a", "track-3"],
  );
});


test("external discovery budgets can stay UI-equivalent while shadow output pool grows", () => {
  const ui = getForYouExternalDiscoveryLimits(4, 4);
  const shadowPool = getForYouExternalDiscoveryLimits(12, 4);

  assert.deepEqual(shadowPool, ui);
  assert.deepEqual(ui, { maxCandidates: 48, evaluationTopN: 16 });
});
