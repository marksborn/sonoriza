import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireLastFmExternalDiscovery,
  evaluateExternalDiscoveryCandidates,
  type ExternalDiscoveryHistoryEvidence,
  type ExternalDiscoverySimilarityProvider,
} from "./external-discovery";

test("Gate 5A deduplicates candidates, ignores seed self-matches and keeps strongest evidence", async () => {
  const provider: ExternalDiscoverySimilarityProvider = {
    async getSimilarArtists({ artistName }) {
      if (artistName === "Broken Seed") throw new Error("provider unavailable");
      if (artistName === "Mudvayne") {
        return [
          { name: "Mudvayne", mbid: "self", match: 1, url: null },
          { name: "Sevendust", mbid: "seven", match: 0.81, url: null },
        ];
      }
      return [
        { name: "Sevendust", mbid: "seven", match: 0.93, url: null },
        { name: "Nonpoint", mbid: "nonpoint", match: 0.84, url: null },
      ];
    },
    async getSimilarTracks() {
      return [
        {
          name: "New Track",
          artistName: "New Artist",
          trackMbid: "new-track",
          artistMbid: "new-artist",
          match: 0.9,
          url: null,
        },
      ];
    },
  };

  const result = await acquireLastFmExternalDiscovery({
    provider,
    artistSeeds: [
      { artistName: "Mudvayne", affinity: 0.9 },
      { artistName: "Disturbed", affinity: 0.95 },
      { artistName: "Broken Seed", affinity: 0.8 },
    ],
    trackSeeds: [
      {
        artistName: "Disturbed",
        trackName: "Stricken",
        artistAffinity: 0.95,
        trackAffinity: 0.88,
      },
    ],
    perSeed: 10,
    maxCandidates: 20,
  });

  assert.equal(result.status, "READY");
  assert.equal(result.providerCalls, 4);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.seedArtistName, "Broken Seed");
  assert.equal(result.candidates.some((row) => row.artistName === "Mudvayne"), false);

  const sevendust = result.candidates.find((row) => row.artistName === "Sevendust");
  assert.ok(sevendust);
  assert.equal(sevendust.similarity, 0.93);
  assert.equal(sevendust.seedArtistName, "Disturbed");
  assert.equal(
    result.candidates.filter((row) => row.artistName === "Sevendust").length,
    1,
  );
  assert.ok(result.candidates.some((row) => row.trackName === "New Track"));
});

test("Gate 5A abstains on provider failure instead of throwing into the generation path", async () => {
  const provider: ExternalDiscoverySimilarityProvider = {
    async getSimilarArtists() {
      throw new Error("Last.fm API error 29: Rate limit exceeded");
    },
    async getSimilarTracks() {
      throw new Error("Last.fm API error 11: Service Offline");
    },
  };

  const result = await acquireLastFmExternalDiscovery({
    provider,
    artistSeeds: [{ artistName: "Seed", affinity: 0.9 }],
    trackSeeds: [
      {
        artistName: "Seed",
        trackName: "Track",
        artistAffinity: 0.9,
        trackAffinity: 0.8,
      },
    ],
  });

  assert.equal(result.status, "ABSTAINED");
  assert.equal(result.abstentionReason, "PROVIDER_ERRORS");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.failures.length, 2);
});

test("Gate 5B preserves artist-level rejection for known artist candidates", async () => {
  const provider: ExternalDiscoverySimilarityProvider = {
    async getSimilarArtists() {
      return [
        { name: "Fresh Artist", mbid: "fresh", match: 0.94, url: null },
        { name: "Known Artist", mbid: "known", match: 0.97, url: null },
      ];
    },
    async getSimilarTracks() {
      return [];
    },
  };

  const acquired = await acquireLastFmExternalDiscovery({
    provider,
    artistSeeds: [{ artistName: "Strong Seed", affinity: 0.92 }],
    trackSeeds: [],
  });
  const evaluated = evaluateExternalDiscoveryCandidates({
    candidates: acquired.candidates,
    historyEvidence: (candidate) =>
      history(candidate.artistName === "Known Artist" ? 12 : 0, 0, "NOT_APPLICABLE"),
  });

  const fresh = evaluated.evaluated.find((row) => row.artistName === "Fresh Artist");
  const known = evaluated.evaluated.find((row) => row.artistName === "Known Artist");
  assert.ok(fresh);
  assert.ok(known);
  assert.equal(fresh.scoreCard.eligible, true);
  assert.equal(fresh.historyClass, "NEW_ARTIST");
  assert.equal(fresh.scoreCard.source, "LASTFM_SIMILAR_ARTIST");
  assert.equal(known.scoreCard.eligible, false);
  assert.equal(known.historyClass, "KNOWN_ARTIST_NOT_NEW");
  assert.equal(known.knownHistoricalPlayCount, 12);
  assert.ok(
    known.scoreCard.reasons.some((reason) => reason.code === "KNOWN_HISTORY_NOT_NEW"),
  );
});

test("Gate 5B keeps an unseen track eligible when only its artist is known", async () => {
  const candidate = acquiredTrack({
    artistName: "Linkin Park",
    trackName: "Unheard Deep Cut",
    artistMbid: "lp",
    trackMbid: "deep-cut",
  });

  const evaluated = evaluateExternalDiscoveryCandidates({
    candidates: [candidate],
    historyEvidence: () => history(801, 0, "NONE"),
  });
  const row = evaluated.evaluated[0];
  assert.ok(row);
  assert.equal(row.artistHistoricalPlayCount, 801);
  assert.equal(row.trackHistoricalPlayCount, 0);
  assert.equal(row.knownHistoricalPlayCount, 0);
  assert.equal(row.historyClass, "NEW_TRACK_KNOWN_ARTIST");
  assert.equal(row.scoreCard.eligible, true);
  assert.ok(row.scoreCard.score > 0);
});

test("Gate 5B rejects a track only when the exact track is present in history", async () => {
  const candidate = acquiredTrack({
    artistName: "Linkin Park",
    trackName: "Papercut",
    artistMbid: "lp",
    trackMbid: "papercut",
  });

  const evaluated = evaluateExternalDiscoveryCandidates({
    candidates: [candidate],
    historyEvidence: () => history(801, 23, "MBID"),
  });
  const row = evaluated.evaluated[0];
  assert.ok(row);
  assert.equal(row.artistHistoricalPlayCount, 801);
  assert.equal(row.trackHistoricalPlayCount, 23);
  assert.equal(row.knownHistoricalPlayCount, 23);
  assert.equal(row.trackHistoryMatch, "MBID");
  assert.equal(row.historyClass, "KNOWN_TRACK_NOT_NEW");
  assert.equal(row.scoreCard.eligible, false);
  assert.equal(row.scoreCard.score, 0);
});

test("Gate 5B labels a track from an unseen artist as NEW_ARTIST", async () => {
  const candidate = acquiredTrack({
    artistName: "Never Heard Before",
    trackName: "First Contact",
    artistMbid: "new-artist",
    trackMbid: "new-track",
  });

  const evaluated = evaluateExternalDiscoveryCandidates({
    candidates: [candidate],
    historyEvidence: () => history(0, 0, "NONE"),
  });
  const row = evaluated.evaluated[0];
  assert.ok(row);
  assert.equal(row.historyClass, "NEW_ARTIST");
  assert.equal(row.scoreCard.eligible, true);
});

function history(
  artistHistoricalPlayCount: number,
  trackHistoricalPlayCount: number,
  trackHistoryMatch: ExternalDiscoveryHistoryEvidence["trackHistoryMatch"],
): ExternalDiscoveryHistoryEvidence {
  return {
    artistHistoricalPlayCount,
    trackHistoricalPlayCount,
    trackHistoryMatch,
  };
}

function acquiredTrack(input: {
  artistName: string;
  trackName: string;
  artistMbid: string | null;
  trackMbid: string | null;
}) {
  return {
    candidateKey: input.trackMbid
      ? `track:mbid:${input.trackMbid}`
      : `track:name:${input.artistName}:${input.trackName}`,
    candidateType: "TRACK" as const,
    artistName: input.artistName,
    trackName: input.trackName,
    artistMbid: input.artistMbid,
    trackMbid: input.trackMbid,
    source: "LASTFM_SIMILAR_TRACK" as const,
    similarity: 0.95,
    sourceConfidence: 0.85,
    seedArtistName: "Strong Seed",
    seedTrackName: "Strong Track",
    seedArtistAffinity: 0.9,
    seedTrackAffinity: 0.88,
  };
}
