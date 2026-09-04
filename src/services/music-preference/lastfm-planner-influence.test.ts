import assert from "node:assert/strict";
import test from "node:test";

import { music06LastFmPlannerCapability } from "@/services/data-policy";

import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import {
  applyMusic06PlannerInfluence,
  DEFAULT_MUSIC_06_PLANNER_PRODUCTIVE_CONFIG,
} from "./lastfm-planner-influence";
import type { Music06PlannerShadowCandidate } from "./lastfm-planner-influence-shadow";
import type {
  Music06ArtistNegativeProjection,
  Music06NegativeProjectionShadow,
  Music06TrackNegativeProjection,
} from "./lastfm-negative-projection-shadow";

const asOf = new Date("2026-09-04T12:00:00.000Z");

function candidate(
  key: string,
  trackName: string,
  artistName = "Artist",
  extras: Partial<Music06PlannerShadowCandidate> = {},
): Music06PlannerShadowCandidate {
  return {
    candidateKey: key,
    type: "MUSIC",
    trackName,
    artistName,
    spotifyTrackId: `spotify-${key}`,
    primaryArtistId: `artist-${artistName.toLowerCase()}`,
    ...extras,
  };
}

function podcast(key: string): Music06PlannerShadowCandidate {
  return { candidateKey: key, type: "PODCAST" };
}

function trackProjection(input: {
  trackName: string;
  artistName?: string;
  assessed?: number;
  negative?: number;
  days?: number;
}): Music06TrackNegativeProjection {
  const artistName = input.artistName ?? "Artist";
  const assessed = input.assessed ?? 4;
  const negative = input.negative ?? 3;
  return {
    trackKey: `${artistName.toLowerCase()}\u0000${input.trackName.toLowerCase()}`,
    identityMethod: "TRACK_ARTIST_NORMALIZED_EXACT",
    trackName: input.trackName,
    artistName,
    assessedOccurrenceCount: assessed,
    inferredSkipCount: negative,
    negativeSignalCount: negative,
    skipRate: negative / assessed,
    recent30d: {
      assessedOccurrenceCount: assessed,
      negativeOccurrenceCount: negative,
      skipRate: negative / assessed,
    },
    recent90d: {
      assessedOccurrenceCount: assessed,
      negativeOccurrenceCount: negative,
      skipRate: negative / assessed,
    },
    recent30dSkipRate: negative / assessed,
    recent90dSkipRate: negative / assessed,
    lastNegativeAt: negative > 0 ? asOf : null,
    distinctNegativeDays: input.days ?? 2,
  };
}

function artistProjection(input: {
  artistName?: string;
  assessed?: number;
  negative?: number;
  negativeTracks?: number;
  days?: number;
} = {}): Music06ArtistNegativeProjection {
  const artistName = input.artistName ?? "Artist";
  const assessed = input.assessed ?? 8;
  const negative = input.negative ?? 4;
  return {
    artistKey: artistName.toLowerCase(),
    identityMethod: "TRACK_ARTIST_NORMALIZED_EXACT",
    artistName,
    assessedOccurrenceCount: assessed,
    negativeOccurrenceCount: negative,
    inferredSkipCount: negative,
    negativeSignalCount: negative,
    skipRate: negative / assessed,
    recent30d: {
      assessedOccurrenceCount: assessed,
      negativeOccurrenceCount: negative,
      skipRate: negative / assessed,
    },
    recent90d: {
      assessedOccurrenceCount: assessed,
      negativeOccurrenceCount: negative,
      skipRate: negative / assessed,
    },
    recent30dSkipRate: negative / assessed,
    recent90dSkipRate: negative / assessed,
    distinctTracksAssessed: 4,
    distinctTracksNegative: input.negativeTracks ?? 2,
    distinctNegativeDays: input.days ?? 2,
    lastNegativeAt: negative > 0 ? asOf : null,
  };
}

function projection(input: {
  tracks?: Music06TrackNegativeProjection[];
  artists?: Music06ArtistNegativeProjection[];
} = {}): Music06NegativeProjectionShadow {
  return {
    mode: "SHADOW_READ_ONLY",
    asOf,
    sourceReportCount: 1,
    assessedOccurrenceCount: 8,
    negativeOccurrenceCount: 4,
    duplicateOccurrenceCount: 0,
    conflictingOccurrenceCount: 0,
    unprojectableOccurrenceCount: 0,
    tracks: input.tracks ?? [],
    artists: input.artists ?? [],
  };
}

function preference(subjectKey: string): FirstPartyPlaybackPreference {
  return {
    id: `pref-${subjectKey}`,
    userId: "user-1",
    subjectType: "TRACK",
    subjectKey,
    policy: "NORMAL",
    source: "USER_EXPLICIT",
    createdAt: asOf,
    updatedAt: asOf,
  };
}

test("Gate 5B applies the validated two-rank track demotion productively", () => {
  const result = applyMusic06PlannerInfluence({
    candidates: [
      candidate("a", "A"),
      candidate("b", "B"),
      candidate("c", "C"),
      candidate("d", "D"),
    ],
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
  });

  assert.equal(result.authorized, true);
  assert.equal(result.applied, true);
  assert.equal(result.eligibilityChanged, false);
  assert.deepEqual(result.candidates.map((row) => row.candidateKey), ["a", "c", "d", "b"]);
  assert.equal(result.maxObservedMusicRankShift, 2);
});

test("Gate 5B preserves podcast slots and candidate cardinality", () => {
  const input = [
    candidate("a", "A"),
    podcast("pod"),
    candidate("b", "B"),
    candidate("c", "C"),
    candidate("d", "D"),
  ];
  const result = applyMusic06PlannerInfluence({
    candidates: input,
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
  });

  assert.deepEqual(result.candidates.map((row) => row.candidateKey), [
    "a",
    "pod",
    "c",
    "d",
    "b",
  ]);
  assert.equal(result.candidates[1]?.type, "PODCAST");
  assert.equal(result.inputCandidateCount, result.outputCandidateCount);
  assert.deepEqual(
    new Set(result.candidates.map((row) => row.candidateKey)),
    new Set(input.map((row) => row.candidateKey)),
  );
});

test("Gate 5B keeps explicit first-party preference stronger than inference", () => {
  const result = applyMusic06PlannerInfluence({
    candidates: [candidate("a", "A"), candidate("b", "B"), candidate("c", "C")],
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
    firstPartyPreferences: [preference("spotify:track:spotify-b")],
  });

  assert.deepEqual(result.candidates.map((row) => row.candidateKey), ["a", "b", "c"]);
  assert.equal(result.applied, false);
  assert.equal(result.explicitPreferenceSuppressedCount, 1);
});

test("Gate 5B still requires the conservative Gate 5A thresholds", () => {
  const result = applyMusic06PlannerInfluence({
    candidates: [candidate("a", "A"), candidate("b", "B"), candidate("c", "C")],
    projection: projection({
      tracks: [trackProjection({ trackName: "B", assessed: 1, negative: 1, days: 1 })],
    }),
  });

  assert.equal(result.applied, false);
  assert.equal(result.influencedCandidateCount, 0);
  assert.deepEqual(result.candidates.map((row) => row.candidateKey), ["a", "b", "c"]);
});

test("Gate 5B cannot apply when its scoped capability is not authorized", () => {
  const capability = music06LastFmPlannerCapability();
  const blocked = {
    ...capability,
    boundedRerankDecision: "REVIEW_REQUIRED" as const,
    boundedRerankAllowed: false,
  };
  const result = applyMusic06PlannerInfluence({
    candidates: [candidate("a", "A"), candidate("b", "B"), candidate("c", "C"), candidate("d", "D")],
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
    capability: blocked,
  });

  assert.equal(result.authorized, false);
  assert.equal(result.applied, false);
  assert.equal(result.influencedCandidateCount, 0);
  assert.deepEqual(result.candidates.map((row) => row.candidateKey), ["a", "b", "c", "d"]);
});

test("Gate 5B combined track and artist influence remains capped at three ranks", () => {
  const result = applyMusic06PlannerInfluence({
    candidates: [
      candidate("a", "A"),
      candidate("b", "B"),
      candidate("c", "C"),
      candidate("d", "D"),
      candidate("e", "E"),
    ],
    projection: projection({
      tracks: [trackProjection({ trackName: "B" })],
      artists: [artistProjection()],
    }),
    config: DEFAULT_MUSIC_06_PLANNER_PRODUCTIVE_CONFIG,
  });

  const influence = result.influences.find((row) => row.candidateKey === "b");
  assert.equal(influence?.actualMusicRankShift, 3);
  assert.equal(result.maxObservedMusicRankShift, 3);
});
