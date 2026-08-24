import assert from "node:assert/strict";
import test from "node:test";

import {
  filterQueuedAlbumUiRecommendations,
  type AlbumUiSnapshotRecommendation,
} from "./ui-snapshot";

function recommendation(id: string): AlbumUiSnapshotRecommendation {
  return {
    spotifyAlbumId: id,
    artistName: `Artist ${id}`,
    albumName: `Album ${id}`,
    releaseDate: "2026-01-01",
    score: 80,
    coveragePercent: 20,
    coverageSummary: "2 de 10 faixas · 20% conhecido",
    plays30d: 0,
    reasons: ["Pouco explorado no seu histórico"],
  };
}

test("filterQueuedAlbumUiRecommendations removes fresh QUEUED albums and fills the visible list", () => {
  const recommendations = ["a", "b", "c", "d", "e", "f", "g"].map(recommendation);
  const queued = new Set(["b", "d"]);

  const result = filterQueuedAlbumUiRecommendations(recommendations, queued, 5);

  assert.deepEqual(
    result.map((row) => row.spotifyAlbumId),
    ["a", "c", "e", "f", "g"],
  );
});

test("filterQueuedAlbumUiRecommendations rejects invalid limits", () => {
  assert.throws(
    () => filterQueuedAlbumUiRecommendations([recommendation("a")], new Set(), 0),
    /positive integer/,
  );
});
