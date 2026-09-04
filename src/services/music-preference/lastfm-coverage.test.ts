import assert from "node:assert/strict";
import test from "node:test";

import type { LastFmListeningEventInput } from "@/services/lastfm/client";

import {
  assessLastFmCoverage,
  matchPublishedOccurrencesToLastFm,
  normalizeMusicIdentityText,
  type LastFmRecentObservation,
  type PublishedMusicOccurrence,
} from "./lastfm-coverage";

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

function observation(input: {
  scrobbles: LastFmListeningEventInput[];
  complete?: boolean;
  nowPlayingCount?: number;
}): LastFmRecentObservation {
  return {
    username: "marks",
    observedAt: new Date("2026-09-03T14:00:00.000Z"),
    requestedFrom: publishedAt,
    requestedTo: new Date("2026-09-03T14:00:00.000Z"),
    pagesFetched: 1,
    totalPages: input.complete === false ? 2 : 1,
    providerTotal: input.scrobbles.length,
    complete: input.complete ?? true,
    nowPlayingCount: input.nowPlayingCount ?? 0,
    invalidCount: 0,
    scrobbles: input.scrobbles,
  };
}

test("Gate 2 identity normalization is exact after case/accent/punctuation folding", () => {
  assert.equal(
    normalizeMusicIdentityText("Beyoncé & JAY-Z — Déjà Vu"),
    "beyonce and jay z deja vu",
  );
});

test("Gate 2 matches only unique normalized track+artist identities", () => {
  const matches = matchPublishedOccurrencesToLastFm({
    occurrences: [occurrence(1, "Déjà Vu", "Beyoncé")],
    scrobbles: [
      scrobble("event-1", "2026-09-03T12:05:00.000Z", "Deja Vu", "BEYONCÉ"),
    ],
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.status, "MATCHED");
  assert.equal(matches[0]?.reason, "MATCHED_UNIQUE_TRACK_ARTIST");
});

test("Gate 2 abstains when the published sequence repeats the same identity", () => {
  const matches = matchPublishedOccurrencesToLastFm({
    occurrences: [
      occurrence(1, "Track A", "Artist"),
      occurrence(2, "Track A", "Artist"),
    ],
    scrobbles: [
      scrobble("event-1", "2026-09-03T12:05:00.000Z", "Track A", "Artist"),
    ],
  });

  assert.deepEqual(
    matches.map((match) => match.status),
    ["AMBIGUOUS", "AMBIGUOUS"],
  );
  assert.ok(
    matches.every((match) => match.reason === "DUPLICATE_PUBLISHED_IDENTITY"),
  );
});

test("Gate 2 abstains when multiple Last.fm scrobbles can match one occurrence", () => {
  const matches = matchPublishedOccurrencesToLastFm({
    occurrences: [occurrence(1, "Track A", "Artist")],
    scrobbles: [
      scrobble("event-1", "2026-09-03T12:05:00.000Z", "Track A", "Artist"),
      scrobble("event-2", "2026-09-03T12:25:00.000Z", "Track A", "Artist"),
    ],
  });

  assert.equal(matches[0]?.status, "AMBIGUOUS");
  assert.equal(matches[0]?.reason, "MULTIPLE_MATCHING_SCROBBLES");
});

test("Gate 2 confirms evaluability for A/B/C when A and C are unique ordered anchors", () => {
  const assessment = assessLastFmCoverage({
    occurrences: [
      occurrence(1, "A", "Artist A"),
      occurrence(2, "B", "Artist B"),
      occurrence(3, "C", "Artist C"),
    ],
    observation: observation({
      scrobbles: [
        scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
        scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
      ],
    }),
  });

  assert.equal(assessment.status, "CONFIRMED");
  assert.equal(assessment.evaluableWindowCount, 1);
  assert.equal(assessment.matchedOccurrenceCount, 2);
  assert.equal(assessment.unmatchedOccurrenceCount, 1);
  assert.equal(assessment.windows[0]?.centerPosition, 2);
  assert.equal(assessment.windows[0]?.evaluable, true);
  // Gate 2 deliberately does not classify the unmatched center as a skip.
  assert.equal(assessment.matches[1]?.status, "UNMATCHED");
});

test("Gate 2 abstains when an unrelated Last.fm scrobble appears between published anchors", () => {
  const assessment = assessLastFmCoverage({
    occurrences: [
      occurrence(1, "A", "Artist A"),
      occurrence(2, "B", "Artist B"),
      occurrence(3, "C", "Artist C"),
    ],
    observation: observation({
      scrobbles: [
        scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
        scrobble("outside", "2026-09-03T12:15:00.000Z", "Outside", "Other Artist"),
        scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
      ],
    }),
  });

  assert.equal(assessment.status, "UNKNOWN");
  assert.equal(assessment.evaluableWindowCount, 0);
  assert.ok(
    assessment.windows[0]?.reasons.includes(
      "UNPLANNED_SCROBBLE_BETWEEN_ANCHORS",
    ),
  );
});

test("Gate 2 does not confirm coverage when center scrobble is outside ordered anchors", () => {
  const assessment = assessLastFmCoverage({
    occurrences: [
      occurrence(1, "A", "Artist A"),
      occurrence(2, "B", "Artist B"),
      occurrence(3, "C", "Artist C"),
    ],
    observation: observation({
      scrobbles: [
        scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
        scrobble("b", "2026-09-03T12:30:00.000Z", "B", "Artist B"),
        scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
      ],
    }),
  });

  assert.equal(assessment.status, "UNKNOWN");
  assert.equal(assessment.evaluableWindowCount, 0);
  assert.ok(
    assessment.windows[0]?.reasons.includes("CENTER_SCROBBLE_OUTSIDE_ANCHORS"),
  );
});

test("Gate 2 pagination truncation forces PARTIAL even with otherwise usable anchors", () => {
  const assessment = assessLastFmCoverage({
    occurrences: [
      occurrence(1, "A", "Artist A"),
      occurrence(2, "B", "Artist B"),
      occurrence(3, "C", "Artist C"),
    ],
    observation: observation({
      complete: false,
      scrobbles: [
        scrobble("a", "2026-09-03T12:10:00.000Z", "A", "Artist A"),
        scrobble("c", "2026-09-03T12:20:00.000Z", "C", "Artist C"),
      ],
    }),
  });

  assert.equal(assessment.status, "PARTIAL");
  assert.equal(assessment.evaluableWindowCount, 0);
  assert.deepEqual(assessment.reasons, ["LASTFM_PAGINATION_INCOMPLETE"]);
});

test("Gate 2 provider failure is UNAVAILABLE and never evaluable", () => {
  const assessment = assessLastFmCoverage({
    occurrences: [
      occurrence(1, "A", "Artist A"),
      occurrence(2, "B", "Artist B"),
      occurrence(3, "C", "Artist C"),
    ],
    observation: null,
    unavailableReason: "Last.fm timeout",
  });

  assert.equal(assessment.status, "UNAVAILABLE");
  assert.equal(assessment.evaluableWindowCount, 0);
  assert.deepEqual(assessment.reasons, ["Last.fm timeout"]);
});

test("Gate 2 now-playing without completed anchors remains UNKNOWN", () => {
  const assessment = assessLastFmCoverage({
    occurrences: [
      occurrence(1, "A", "Artist A"),
      occurrence(2, "B", "Artist B"),
      occurrence(3, "C", "Artist C"),
    ],
    observation: observation({ scrobbles: [], nowPlayingCount: 1 }),
  });

  assert.equal(assessment.status, "UNKNOWN");
  assert.equal(assessment.evaluableWindowCount, 0);
  assert.ok(assessment.reasons.includes("NOW_PLAYING_SEEN_ONLY_OR_INSUFFICIENT"));
});
