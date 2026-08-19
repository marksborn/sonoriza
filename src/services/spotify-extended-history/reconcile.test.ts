import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyExtendedMusicEvent } from "./parser";
import {
  reconcileSpotifyExtendedHistory,
  summarizeAbsoluteDeltas,
  type ExistingListeningEvent,
} from "./reconcile";

test("HISTORY-02 reconciles strong Spotify and conservative Last.fm matches", () => {
  const exports = [
    event("spotify", "Artist A", "Track A", "2026-08-18T10:00:00Z"),
    event("lastfm", "Artist B", "Track B", "2026-08-18T11:00:00Z"),
    event("new", "Artist C", "Track C", "2026-08-18T12:00:00Z"),
    event("conflict", "Artist D", "Track D", "2026-08-18T13:00:00Z"),
    event("near", "Artist E", "Track E", "2026-08-18T14:00:00Z"),
  ];

  const existing: ExistingListeningEvent[] = [
    existing("rp-a", "spotify", "Other metadata name is irrelevant", "Other artist", "2026-08-18T10:00:30Z", "SPOTIFY_RECENTLY_PLAYED"),
    existing("lf-b", null, "Track B", "Artist B", "2026-08-18T11:00:10Z", "LASTFM_SCROBBLE"),
    existing("lf-d1", null, "Track D", "Artist D", "2026-08-18T13:00:20Z", "LASTFM_SCROBBLE"),
    existing("lf-d2", null, "Track D", "Artist D", "2026-08-18T13:00:40Z", "LASTFM_SCROBBLE"),
    existing("rp-near", "near", "Track E", "Artist E", "2026-08-18T14:05:00Z", "SPOTIFY_RECENTLY_PLAYED"),
  ];

  const result = reconcileSpotifyExtendedHistory(exports, existing);
  assert.deepEqual(
    result.entries.map((entry) => entry.classification),
    [
      "EXACT_EXISTING_RECENTLY_PLAYED",
      "EXACT_EXISTING_LASTFM",
      "NEW_UNCOVERED_EVENT",
      "CONFLICT_AMBIGUOUS",
      "CONFLICT_AMBIGUOUS",
    ],
  );
  assert.equal(result.summary.exactExistingRecentlyPlayed, 1);
  assert.equal(result.summary.exactExistingLastFm, 1);
  assert.equal(result.summary.newUncoveredEvents, 1);
  assert.equal(result.summary.conflictAmbiguous, 2);
  assert.equal(result.summary.enrichmentCandidates, 2);
  assert.equal(result.summary.estimatedInserts, 1);
});

test("HISTORY-02 treats ts as stop time and matches against estimated start time", () => {
  const exportEvent = event("timing", "Artist", "Track", "2026-08-18T10:00:00Z", 180000);
  const existingAtStart = existing("lf", null, "Track", "Artist", "2026-08-18T10:00:00Z", "LASTFM_SCROBBLE");
  const result = reconcileSpotifyExtendedHistory([exportEvent], [existingAtStart]);
  assert.equal(result.entries[0]?.classification, "EXACT_EXISTING_LASTFM");
  assert.equal(result.entries[0]?.matchDeltaMs, 0);
});

test("HISTORY-02 does not re-enrich an already enriched canonical event", () => {
  const exportEvent = event("enriched", "Artist", "Track", "2026-08-18T10:00:00Z");
  const existingEvent: ExistingListeningEvent = {
    ...existing("rp", "enriched", "Track", "Artist", "2026-08-18T10:00:00Z", "SPOTIFY_RECENTLY_PLAYED"),
    metadata: { spotifyExtendedHistory: { sourceEventKey: exportEvent.sourceEventKey } },
  };
  const result = reconcileSpotifyExtendedHistory([exportEvent], [existingEvent]);
  assert.equal(result.entries[0]?.enrichmentCandidate, false);
  assert.equal(result.summary.enrichmentCandidates, 0);
});

test("HISTORY-02 delta summary is deterministic", () => {
  assert.deepEqual(summarizeAbsoluteDeltas([1000, 3000, 2000, 10000]), {
    count: 4,
    p50Ms: 2000,
    p95Ms: 10000,
    maxMs: 10000,
  });
  assert.deepEqual(summarizeAbsoluteDeltas([]), {
    count: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  });
});

function event(
  id: string,
  artistName: string,
  trackName: string,
  estimatedStartedAt: string,
  msPlayed = 0,
): SpotifyExtendedMusicEvent {
  const start = new Date(estimatedStartedAt);
  const endedAt = new Date(start.getTime() + msPlayed);
  return {
    sourceFile: "fixture.json",
    sourceIndex: 0,
    endedAt,
    estimatedStartedAt: start,
    msPlayed,
    spotifyTrackUri: `spotify:track:${id}`,
    spotifyTrackId: id,
    trackName,
    artistName,
    albumName: "Album",
    reasonStart: null,
    reasonEnd: null,
    skipped: false,
    offline: false,
    offlineTimestamp: null,
    incognitoMode: false,
    sourceEventKey: `key-${id}`,
  };
}

function existing(
  id: string,
  spotifyTrackId: string | null,
  trackName: string,
  artistName: string,
  playedAt: string,
  source: string,
): ExistingListeningEvent {
  return {
    id,
    spotifyTrackId,
    trackName,
    artistName,
    playedAt: new Date(playedAt),
    source,
    metadata: null,
  };
}
