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
} from "./lastfm-gap-shadow";
import type { Music06LastFmGapReport } from "./lastfm-gap-shadow-report";
import { projectMusic06NegativeShadow } from "./lastfm-negative-projection-shadow";

const AS_OF = new Date("2026-09-03T12:00:00.000Z");
const TARGET_ID = "target-1";

function occurrence(input: {
  runId: string;
  position: number;
  trackName: string;
  artistName: string;
  publishedAt: Date;
}): PublishedMusicOccurrence {
  return {
    generationRunId: input.runId,
    targetPlaylistId: TARGET_ID,
    generationItemId: `${input.runId}-item-${input.position}`,
    position: input.position,
    publishedAt: input.publishedAt,
    trackName: input.trackName,
    artistName: input.artistName,
    spotifyTrackId: `spotify-${input.runId}-${input.position}`,
  };
}

function scrobble(input: {
  key: string;
  playedAt: Date;
  trackName: string;
  artistName: string;
}): LastFmListeningEventInput {
  return {
    source: "LASTFM_SCROBBLE",
    sourceEventKey: input.key,
    playedAt: input.playedAt,
    trackName: input.trackName,
    artistName: input.artistName,
    albumName: null,
    trackMbid: null,
    artistMbid: null,
    albumMbid: null,
    lastFmUrl: null,
    loved: null,
  };
}

function report(input: {
  runId: string;
  publishedAt: Date;
  centerTrack?: string;
  centerArtist?: string;
  scrobbleCenter: boolean;
  includeAnchors?: boolean;
  centerPlayedAt?: Date;
}): Music06LastFmGapReport {
  const centerTrack = input.centerTrack ?? "Track B";
  const centerArtist = input.centerArtist ?? "Artist One";
  const occurrences = [
    occurrence({
      runId: input.runId,
      position: 1,
      trackName: "Track A",
      artistName: "Anchor Artist A",
      publishedAt: input.publishedAt,
    }),
    occurrence({
      runId: input.runId,
      position: 2,
      trackName: centerTrack,
      artistName: centerArtist,
      publishedAt: input.publishedAt,
    }),
    occurrence({
      runId: input.runId,
      position: 3,
      trackName: "Track C",
      artistName: "Anchor Artist C",
      publishedAt: input.publishedAt,
    }),
  ];
  const aAt = new Date(input.publishedAt.getTime() + 10 * 60_000);
  const bAt = input.centerPlayedAt ?? new Date(input.publishedAt.getTime() + 15 * 60_000);
  const cAt = new Date(input.publishedAt.getTime() + 20 * 60_000);
  const events: LastFmListeningEventInput[] = [];
  if (input.includeAnchors ?? true) {
    events.push(
      scrobble({
        key: `${input.runId}-a`,
        playedAt: aAt,
        trackName: "Track A",
        artistName: "Anchor Artist A",
      }),
    );
  }
  if (input.scrobbleCenter) {
    events.push(
      scrobble({
        key: `${input.runId}-b`,
        playedAt: bAt,
        trackName: centerTrack,
        artistName: centerArtist,
      }),
    );
  }
  if (input.includeAnchors ?? true) {
    events.push(
      scrobble({
        key: `${input.runId}-c`,
        playedAt: cAt,
        trackName: "Track C",
        artistName: "Anchor Artist C",
      }),
    );
  }

  const observation: LastFmRecentObservation = {
    username: "marksborn",
    observedAt: AS_OF,
    requestedFrom: input.publishedAt,
    requestedTo: new Date(input.publishedAt.getTime() + 60 * 60_000),
    pagesFetched: 1,
    totalPages: 1,
    providerTotal: events.length,
    complete: true,
    nowPlayingCount: 0,
    invalidCount: 0,
    scrobbles: events,
  };
  const assessment = assessLastFmCoverage({ occurrences, observation });
  const shadow = inferMusic06LastFmGapShadow(assessment);

  return {
    mode: "SHADOW_READ_ONLY",
    coverage: {
      mode: "SHADOW_READ_ONLY",
      userId: "user-1",
      username: "marksborn",
      generationRunId: input.runId,
      publishedAt: input.publishedAt,
      requestedFrom: observation.requestedFrom,
      requestedTo: observation.requestedTo,
      providerStatus: "AVAILABLE",
      providerError: null,
      observation,
      targets: [{ targetPlaylistId: TARGET_ID, assessment }],
    },
    assessedWindowCount: shadow.assessedWindowCount,
    inferredGapCount: shadow.inferredGapCount,
    targets: [
      {
        targetPlaylistId: TARGET_ID,
        coverageStatus: assessment.status,
        shadow,
      },
    ],
  };
}

test("Gate 4 UNKNOWN coverage contributes no assessed occurrence", () => {
  const projection = projectMusic06NegativeShadow({
    reports: [
      report({
        runId: "run-unknown",
        publishedAt: new Date("2026-09-03T08:00:00.000Z"),
        scrobbleCenter: false,
        includeAnchors: false,
      }),
    ],
    asOf: AS_OF,
  });

  assert.equal(projection.assessedOccurrenceCount, 0);
  assert.equal(projection.negativeOccurrenceCount, 0);
  assert.deepEqual(projection.tracks, []);
  assert.deepEqual(projection.artists, []);
});

test("Gate 4 counts a matched center as assessed without creating a negative", () => {
  const projection = projectMusic06NegativeShadow({
    reports: [
      report({
        runId: "run-listened",
        publishedAt: new Date("2026-09-03T08:00:00.000Z"),
        scrobbleCenter: true,
      }),
    ],
    asOf: AS_OF,
  });

  assert.equal(projection.assessedOccurrenceCount, 1);
  assert.equal(projection.negativeOccurrenceCount, 0);
  assert.equal(projection.tracks.length, 1);
  assert.equal(projection.tracks[0]?.assessedOccurrenceCount, 1);
  assert.equal(projection.tracks[0]?.inferredSkipCount, 0);
  assert.equal(projection.tracks[0]?.skipRate, 0);
  assert.equal(projection.artists[0]?.negativeOccurrenceCount, 0);
});

test("Gate 4 A✓ B✕ C✓ projects one inferred negative for B", () => {
  const projection = projectMusic06NegativeShadow({
    reports: [
      report({
        runId: "run-gap",
        publishedAt: new Date("2026-09-03T08:00:00.000Z"),
        scrobbleCenter: false,
      }),
    ],
    asOf: AS_OF,
  });

  assert.equal(projection.assessedOccurrenceCount, 1);
  assert.equal(projection.negativeOccurrenceCount, 1);
  assert.equal(projection.tracks[0]?.trackName, "Track B");
  assert.equal(projection.tracks[0]?.inferredSkipCount, 1);
  assert.equal(projection.tracks[0]?.negativeSignalCount, 1);
  assert.equal(projection.tracks[0]?.skipRate, 1);
  assert.equal(projection.tracks[0]?.distinctNegativeDays, 1);
  assert.equal(projection.artists[0]?.negativeOccurrenceCount, 1);
});

test("Gate 4 aggregates the same normalized track across runs and keeps 30/90-day denominators evaluable-only", () => {
  const recentGap = report({
    runId: "run-recent-gap",
    publishedAt: new Date("2026-08-25T08:00:00.000Z"),
    centerTrack: "Déjà Vu",
    centerArtist: "Beyoncé",
    scrobbleCenter: false,
  });
  const oldListened = report({
    runId: "run-old-listened",
    publishedAt: new Date("2026-04-01T08:00:00.000Z"),
    centerTrack: "Deja Vu",
    centerArtist: "BEYONCÉ",
    scrobbleCenter: true,
  });

  const projection = projectMusic06NegativeShadow({
    reports: [recentGap, oldListened],
    asOf: AS_OF,
  });

  assert.equal(projection.tracks.length, 1);
  const track = projection.tracks[0]!;
  assert.equal(track.assessedOccurrenceCount, 2);
  assert.equal(track.inferredSkipCount, 1);
  assert.equal(track.skipRate, 0.5);
  assert.deepEqual(track.recent30d, {
    assessedOccurrenceCount: 1,
    negativeOccurrenceCount: 1,
    skipRate: 1,
  });
  assert.deepEqual(track.recent90d, {
    assessedOccurrenceCount: 1,
    negativeOccurrenceCount: 1,
    skipRate: 1,
  });
});

test("Gate 4 artist projection counts distinct assessed/negative tracks and negative days", () => {
  const projection = projectMusic06NegativeShadow({
    reports: [
      report({
        runId: "run-artist-1",
        publishedAt: new Date("2026-08-20T08:00:00.000Z"),
        centerTrack: "Song One",
        centerArtist: "Same Artist",
        scrobbleCenter: false,
      }),
      report({
        runId: "run-artist-2",
        publishedAt: new Date("2026-08-22T08:00:00.000Z"),
        centerTrack: "Song Two",
        centerArtist: "Same Artist",
        scrobbleCenter: false,
      }),
      report({
        runId: "run-artist-3",
        publishedAt: new Date("2026-08-23T08:00:00.000Z"),
        centerTrack: "Song Three",
        centerArtist: "Same Artist",
        scrobbleCenter: true,
      }),
    ],
    asOf: AS_OF,
  });

  const artist = projection.artists.find((row) => row.artistName === "Same Artist")!;
  assert.equal(artist.assessedOccurrenceCount, 3);
  assert.equal(artist.negativeOccurrenceCount, 2);
  assert.equal(artist.skipRate, 2 / 3);
  assert.equal(artist.distinctTracksAssessed, 3);
  assert.equal(artist.distinctTracksNegative, 2);
  assert.equal(artist.distinctNegativeDays, 2);
});

test("Gate 4 deduplicates an identical re-run of the same occurrence", () => {
  const source = report({
    runId: "run-duplicate",
    publishedAt: new Date("2026-08-25T08:00:00.000Z"),
    scrobbleCenter: false,
  });
  const projection = projectMusic06NegativeShadow({
    reports: [source, source],
    asOf: AS_OF,
  });

  assert.equal(projection.sourceReportCount, 2);
  assert.equal(projection.assessedOccurrenceCount, 1);
  assert.equal(projection.negativeOccurrenceCount, 1);
  assert.equal(projection.duplicateOccurrenceCount, 1);
  assert.equal(projection.conflictingOccurrenceCount, 0);
});

test("Gate 4 fails closed when the same occurrence is reported with conflicting behavioral facts", () => {
  const publishedAt = new Date("2026-08-25T08:00:00.000Z");
  const negative = report({
    runId: "run-conflict",
    publishedAt,
    scrobbleCenter: false,
  });
  const listened = report({
    runId: "run-conflict",
    publishedAt,
    scrobbleCenter: true,
  });

  const projection = projectMusic06NegativeShadow({
    reports: [negative, listened],
    asOf: AS_OF,
  });

  assert.equal(projection.assessedOccurrenceCount, 0);
  assert.equal(projection.negativeOccurrenceCount, 0);
  assert.equal(projection.duplicateOccurrenceCount, 1);
  assert.equal(projection.conflictingOccurrenceCount, 1);
});
