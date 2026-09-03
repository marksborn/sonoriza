import assert from "node:assert/strict";
import test from "node:test";

import type { LastFmListeningEventInput } from "@/services/lastfm/client";

import {
  assessLastFmCoverage,
  type LastFmRecentObservation,
  type PublishedMusicOccurrence,
} from "./lastfm-coverage";
import {
  inferMusic06LastFmGapShadow,
  MUSIC_06_LASTFM_GAP_METHOD,
} from "./lastfm-gap-shadow";

const publishedAt = new Date("2026-09-03T12:00:00.000Z");

function occurrence(
  position: number,
  trackName: string,
  artistName: string,
): PublishedMusicOccurrence {
  return {
    generationRunId: "run-1",
    targetPlaylistId: "target-1",
    generationItemId: `item-${position}`,
    position,
    publishedAt,
    trackName,
    artistName,
    spotifyTrackId: `spotify-${position}`,
  };
}

function scrobble(
  key: string,
  playedAt: string,
  trackName: string,
  artistName: string,
): LastFmListeningEventInput {
  return {
    source: "LASTFM_SCROBBLE",
    sourceEventKey: key,
    playedAt: new Date(playedAt),
    trackName,
    artistName,
    albumName: null,
    trackMbid: null,
    artistMbid: null,
    albumMbid: null,
    lastFmUrl: null,
    loved: null,
  };
}

function observation(
  scrobbles: LastFmListeningEventInput[],
): LastFmRecentObservation {
  return {
    username: "marksborn",
    observedAt: new Date("2026-09-03T14:00:00.000Z"),
    requestedFrom: publishedAt,
    requestedTo: new Date("2026-09-03T14:00:00.000Z"),
    pagesFetched: 1,
    totalPages: 1,
    providerTotal: scrobbles.length,
    complete: true,
    nowPlayingCount: 0,
    invalidCount: 0,
    scrobbles,
  };
}

const sequence = [
  occurrence(1, "A", "Artist A"),
  occurrence(2, "B", "Artist B"),
  occurrence(3, "C", "Artist C"),
];

test("Gate 3 A✓ B✕ C✓ emits one LASTFM_PLANNED_SEQUENCE_GAP shadow evidence", () => {
  const coverage = assessLastFmCoverage({
    occurrences: sequence,
    observation: observation([
      scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
      scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
    ]),
  });

  const result = inferMusic06LastFmGapShadow(coverage);

  assert.equal(coverage.status, "CONFIRMED");
  assert.equal(result.inferredGapCount, 1);
  assert.equal(result.assessedWindowCount, 1);
  assert.equal(result.gaps[0]?.position, 2);
  assert.equal(result.gaps[0]?.trackName, "B");
  assert.equal(result.gaps[0]?.evidenceMethod, MUSIC_06_LASTFM_GAP_METHOD);
  assert.equal(result.gaps[0]?.evidenceLevel, "INFERRED");
});

test("Gate 3 A✓ B✓ C✓ emits no negative gap evidence", () => {
  const coverage = assessLastFmCoverage({
    occurrences: sequence,
    observation: observation([
      scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
      scrobble("b", "2026-09-03T12:15:00.000Z", "B", "Artist B"),
      scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
    ]),
  });

  const result = inferMusic06LastFmGapShadow(coverage);

  assert.equal(result.assessedWindowCount, 1);
  assert.equal(result.inferredGapCount, 0);
});

test("Gate 3 UNKNOWN coverage emits no gap", () => {
  const coverage = assessLastFmCoverage({
    occurrences: sequence,
    observation: observation([]),
  });

  const result = inferMusic06LastFmGapShadow(coverage);

  assert.equal(coverage.status, "UNKNOWN");
  assert.equal(result.assessedWindowCount, 0);
  assert.equal(result.inferredGapCount, 0);
});

test("Gate 3 abstains when unrelated listening occurs between A and C", () => {
  const coverage = assessLastFmCoverage({
    occurrences: sequence,
    observation: observation([
      scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
      scrobble("x", "2026-09-03T12:15:00.000Z", "X", "Other Artist"),
      scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
    ]),
  });

  const result = inferMusic06LastFmGapShadow(coverage);

  assert.equal(coverage.status, "UNKNOWN");
  assert.equal(result.inferredGapCount, 0);
});

test("Gate 3 ambiguous center identity never becomes a gap", () => {
  const repeated = [
    occurrence(1, "A", "Artist A"),
    occurrence(2, "B", "Artist B"),
    occurrence(3, "B", "Artist B"),
    occurrence(4, "C", "Artist C"),
  ];
  const coverage = assessLastFmCoverage({
    occurrences: repeated,
    observation: observation([
      scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
      scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
    ]),
  });

  const result = inferMusic06LastFmGapShadow(coverage);

  assert.equal(result.inferredGapCount, 0);
});

test("Gate 3 shadow is deterministic for identical coverage facts", () => {
  const coverage = assessLastFmCoverage({
    occurrences: sequence,
    observation: observation([
      scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
      scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
    ]),
  });

  assert.deepEqual(
    inferMusic06LastFmGapShadow(coverage),
    inferMusic06LastFmGapShadow(coverage),
  );
});
