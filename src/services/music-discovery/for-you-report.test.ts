import assert from "node:assert/strict";
import test from "node:test";

import {
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
