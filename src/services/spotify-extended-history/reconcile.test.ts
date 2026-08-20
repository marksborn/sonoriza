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

  const existingEvents: ExistingListeningEvent[] = [
    existingEvent("rp-a", "spotify", "Other metadata name is irrelevant", "Other artist", "2026-08-18T10:00:30Z", "SPOTIFY_RECENTLY_PLAYED"),
    existingEvent("lf-b", null, "Track B", "Artist B", "2026-08-18T11:00:10Z", "LASTFM_SCROBBLE"),
    existingEvent("lf-d1", null, "Track D", "Artist D", "2026-08-18T13:00:20Z", "LASTFM_SCROBBLE"),
    existingEvent("lf-d2", null, "Track D", "Artist D", "2026-08-18T13:00:40Z", "LASTFM_SCROBBLE"),
    existingEvent("rp-near", "near", "Track E", "Artist E", "2026-08-18T14:05:00Z", "SPOTIFY_RECENTLY_PLAYED"),
  ];

  const result = reconcileSpotifyExtendedHistory(exports, existingEvents);
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
  assert.deepEqual(
    result.entries.map((entry) => entry.conflictReason),
    [null, null, null, "MULTIPLE_CONFIDENT_LASTFM", "NEAR_ONLY_SPOTIFY"],
  );
  assert.equal(result.entries[3]?.nearestCandidateDeltaMs, 20_000);
  assert.equal(result.entries[4]?.nearestCandidateDeltaMs, 5 * 60 * 1000);
  assert.equal(result.summary.exactExistingRecentlyPlayed, 1);
  assert.equal(result.summary.exactExistingLastFm, 1);
  assert.equal(result.summary.newUncoveredEvents, 1);
  assert.equal(result.summary.conflictAmbiguous, 2);
  assert.equal(result.summary.enrichmentCandidates, 2);
  assert.equal(result.summary.estimatedInserts, 1);
  assert.equal(result.summary.conflictReasonCounts.MULTIPLE_CONFIDENT_LASTFM, 1);
  assert.equal(result.summary.conflictReasonCounts.NEAR_ONLY_SPOTIFY, 1);
  assert.deepEqual(result.summary.conflictCandidateCountBuckets, {
    one: 1,
    two: 1,
    three: 0,
    four: 0,
    fiveOrMore: 0,
  });
});

test("HISTORY-02 matches URI-less music only by conservative exact Last.fm identity", () => {
  const exports = [
    eventWithoutUri("exact", "  ARTIST H  ", "Track   H", "2026-08-18T10:00:00Z"),
    eventWithoutUri("recent-only", "Artist I", "Track I", "2026-08-18T11:00:00Z"),
    eventWithoutUri("near", "Artist J", "Track J", "2026-08-18T12:00:00Z"),
    eventWithoutUri("multiple", "Artist K", "Track K", "2026-08-18T13:00:00Z"),
    eventWithoutUri("version", "Artist L", "Track L", "2026-08-18T14:00:00Z"),
  ];

  const existingEvents: ExistingListeningEvent[] = [
    // Exact normalized Last.fm identity inside the 2-minute confidence window.
    existingEvent("lf-h", null, "track h", "artist h", "2026-08-18T10:00:30Z", "LASTFM_SCROBBLE"),

    // Same textual metadata in Recently Played is deliberately ignored because
    // the URI-less export row has no Spotify track id to prove catalog identity.
    existingEvent("rp-i", "different-spotify-id", "Track I", "Artist I", "2026-08-18T11:00:10Z", "SPOTIFY_RECENTLY_PLAYED"),

    // Same Last.fm identity, but only in the 10-minute ambiguous window.
    existingEvent("lf-j", null, "Track J", "Artist J", "2026-08-18T12:05:00Z", "LASTFM_SCROBBLE"),

    // Two equally confident Last.fm candidates must never be auto-selected.
    existingEvent("lf-k1", null, "Track K", "Artist K", "2026-08-18T13:00:20Z", "LASTFM_SCROBBLE"),
    existingEvent("lf-k2", null, "Track K", "Artist K", "2026-08-18T13:00:40Z", "LASTFM_SCROBBLE"),

    // Similar/remastered title is not fuzzy-matched even at the same timestamp.
    existingEvent("lf-l", null, "Track L - Remastered", "Artist L", "2026-08-18T14:00:00Z", "LASTFM_SCROBBLE"),
  ];

  const result = reconcileSpotifyExtendedHistory(exports, existingEvents);

  assert.deepEqual(
    result.entries.map((entry) => entry.classification),
    [
      "EXACT_EXISTING_LASTFM",
      "NEW_UNCOVERED_EVENT",
      "CONFLICT_AMBIGUOUS",
      "CONFLICT_AMBIGUOUS",
      "NEW_UNCOVERED_EVENT",
    ],
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.conflictReason),
    [null, null, "NEAR_ONLY_LASTFM", "MULTIPLE_CONFIDENT_LASTFM", null],
  );

  assert.equal(result.entries[0]?.matchedExistingEventId, "lf-h");
  assert.equal(result.entries[0]?.matchDeltaMs, 30_000);
  assert.equal(result.entries[1]?.matchedExistingEventId, null);
  assert.equal(result.entries[2]?.nearestCandidateDeltaMs, 5 * 60 * 1000);
  assert.equal(result.entries[3]?.candidateCount, 2);

  assert.equal(result.summary.exactExistingLastFm, 1);
  assert.equal(result.summary.exactExistingRecentlyPlayed, 0);
  assert.equal(result.summary.newUncoveredEvents, 2);
  assert.equal(result.summary.conflictAmbiguous, 2);
  assert.equal(result.summary.enrichmentCandidates, 1);
  assert.equal(result.summary.estimatedInserts, 2);
  assert.equal(result.summary.conflictReasonCounts.NEAR_ONLY_LASTFM, 1);
  assert.equal(result.summary.conflictReasonCounts.MULTIPLE_CONFIDENT_LASTFM, 1);
});

test("HISTORY-02 diagnoses cross-source confident and near conflicts", () => {
  const confident = event("cross-confident", "Artist F", "Track F", "2026-08-18T15:00:00Z");
  const near = event("cross-near", "Artist G", "Track G", "2026-08-18T16:00:00Z");

  const existingEvents: ExistingListeningEvent[] = [
    existingEvent("rp-f", "cross-confident", "Track F", "Artist F", "2026-08-18T15:00:30Z", "SPOTIFY_RECENTLY_PLAYED"),
    existingEvent("lf-f", null, "Track F", "Artist F", "2026-08-18T15:01:00Z", "LASTFM_SCROBBLE"),
    existingEvent("rp-g", "cross-near", "Track G", "Artist G", "2026-08-18T16:05:00Z", "SPOTIFY_RECENTLY_PLAYED"),
    existingEvent("lf-g", null, "Track G", "Artist G", "2026-08-18T16:06:00Z", "LASTFM_SCROBBLE"),
  ];

  const result = reconcileSpotifyExtendedHistory([confident, near], existingEvents);
  assert.equal(result.entries[0]?.conflictReason, "CONFIDENT_CROSS_SOURCE");
  assert.equal(result.entries[1]?.conflictReason, "NEAR_CROSS_SOURCE");
  assert.equal(result.summary.conflictReasonCounts.CONFIDENT_CROSS_SOURCE, 1);
  assert.equal(result.summary.conflictReasonCounts.NEAR_CROSS_SOURCE, 1);
  assert.deepEqual(result.summary.conflictCandidateCountBuckets, {
    one: 0,
    two: 2,
    three: 0,
    four: 0,
    fiveOrMore: 0,
  });
});

test("HISTORY-02 treats ts as stop time and matches against estimated start time", () => {
  const exportEvent = event("timing", "Artist", "Track", "2026-08-18T10:00:00Z", 180000);
  const existingAtStart = existingEvent("lf", null, "Track", "Artist", "2026-08-18T10:00:00Z", "LASTFM_SCROBBLE");
  const result = reconcileSpotifyExtendedHistory([exportEvent], [existingAtStart]);
  assert.equal(result.entries[0]?.classification, "EXACT_EXISTING_LASTFM");
  assert.equal(result.entries[0]?.matchDeltaMs, 0);
});

test("HISTORY-02 does not re-enrich an already enriched canonical event", () => {
  const exportEvent = event("enriched", "Artist", "Track", "2026-08-18T10:00:00Z");
  const existingEventRow: ExistingListeningEvent = {
    ...existingEvent("rp", "enriched", "Track", "Artist", "2026-08-18T10:00:00Z", "SPOTIFY_RECENTLY_PLAYED"),
    metadata: { spotifyExtendedHistory: { sourceEventKey: exportEvent.sourceEventKey } },
  };
  const result = reconcileSpotifyExtendedHistory([exportEvent], [existingEventRow]);
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

function eventWithoutUri(
  id: string,
  artistName: string,
  trackName: string,
  estimatedStartedAt: string,
): SpotifyExtendedMusicEvent {
  const base = event(id, artistName, trackName, estimatedStartedAt);
  return {
    ...base,
    spotifyTrackUri: null,
    spotifyTrackId: null,
    sourceEventKey: `key-no-uri-${id}`,
  };
}

function existingEvent(
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
