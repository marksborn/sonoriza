import assert from "node:assert/strict";
import test from "node:test";

import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import {
  DEFAULT_MUSIC_06_PLANNER_INFLUENCE_SHADOW_CONFIG,
  evaluateMusic06PlannerInfluenceCapability,
  previewMusic06PlannerInfluenceShadow,
  type Music06PlannerShadowCandidate,
} from "./lastfm-planner-influence-shadow";
import type {
  Music06ArtistNegativeProjection,
  Music06NegativeProjectionShadow,
  Music06TrackNegativeProjection,
} from "./lastfm-negative-projection-shadow";

const asOf = new Date("2026-09-03T12:00:00.000Z");

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

function preference(input: {
  subjectType: "TRACK" | "ARTIST";
  subjectKey: string;
  policy?: "PREFERRED" | "NORMAL" | "REDUCED" | "EXCLUDED";
}): FirstPartyPlaybackPreference {
  return {
    id: `pref-${input.subjectKey}`,
    userId: "user-1",
    subjectType: input.subjectType,
    subjectKey: input.subjectKey,
    policy: input.policy ?? "NORMAL",
    source: "USER_EXPLICIT",
    createdAt: asOf,
    updatedAt: asOf,
  };
}

test("Gate 5 exposes current Last.fm capability as REVIEW_REQUIRED instead of bypassing policy", () => {
  const capability = evaluateMusic06PlannerInfluenceCapability();
  assert.equal(capability.recommendationDecision, "REVIEW_REQUIRED");
  assert.equal(capability.plannerEligibilityDecision, "REVIEW_REQUIRED");
  assert.equal(capability.productivelyAuthorized, false);
});

test("Gate 5 insufficient track evidence leaves hypothetical order unchanged", () => {
  const candidates = [candidate("a", "A"), candidate("b", "B"), candidate("c", "C")];
  const result = previewMusic06PlannerInfluenceShadow({
    candidates,
    projection: projection({
      tracks: [trackProjection({ trackName: "B", assessed: 2, negative: 2 })],
    }),
  });

  assert.deepEqual(result.hypotheticalCandidates.map((row) => row.candidateKey), ["a", "b", "c"]);
  assert.equal(result.influencedCandidateCount, 0);
});

test("Gate 5 qualifying track projection demotes at most two MUSIC ranks", () => {
  const result = previewMusic06PlannerInfluenceShadow({
    candidates: [
      candidate("a", "A"),
      candidate("b", "B"),
      candidate("c", "C"),
      candidate("d", "D"),
    ],
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
  });

  assert.deepEqual(result.hypotheticalCandidates.map((row) => row.candidateKey), ["a", "c", "d", "b"]);
  const b = result.influences.find((row) => row.candidateKey === "b");
  assert.equal(b?.requestedMusicRankShift, 2);
  assert.equal(b?.actualMusicRankShift, 2);
  assert.deepEqual(b?.reasons, ["TRACK_NEGATIVE_PROJECTION"]);
});

test("Gate 5 track plus artist influence is capped at three MUSIC ranks", () => {
  const result = previewMusic06PlannerInfluenceShadow({
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
  });

  const b = result.influences.find((row) => row.candidateKey === "b");
  assert.equal(b?.requestedMusicRankShift, 3);
  assert.equal(b?.actualMusicRankShift, 3);
  assert.deepEqual(b?.reasons, [
    "TRACK_NEGATIVE_PROJECTION",
    "ARTIST_NEGATIVE_PROJECTION",
  ]);
});

test("Gate 5 any explicit first-party track preference suppresses inferred demotion", () => {
  const candidates = [candidate("a", "A"), candidate("b", "B"), candidate("c", "C")];
  const result = previewMusic06PlannerInfluenceShadow({
    candidates,
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
    firstPartyPreferences: [
      preference({
        subjectType: "TRACK",
        subjectKey: "spotify:track:spotify-b",
        policy: "NORMAL",
      }),
    ],
  });

  assert.deepEqual(result.hypotheticalCandidates.map((row) => row.candidateKey), ["a", "b", "c"]);
  assert.equal(result.explicitPreferenceSuppressedCount, 1);
  assert.equal(result.influencedCandidateCount, 0);
});

test("Gate 5 explicit artist preference also suppresses inferred track/artist evidence", () => {
  const result = previewMusic06PlannerInfluenceShadow({
    candidates: [candidate("a", "A"), candidate("b", "B"), candidate("c", "C")],
    projection: projection({
      tracks: [trackProjection({ trackName: "B" })],
      artists: [artistProjection()],
    }),
    firstPartyPreferences: [
      preference({
        subjectType: "ARTIST",
        subjectKey: "spotify:artist:artist-artist",
        policy: "PREFERRED",
      }),
    ],
  });

  assert.equal(result.influencedCandidateCount, 0);
  assert.equal(result.explicitPreferenceSuppressedCount, 3);
});

test("Gate 5 artist projection requires multiple negative tracks", () => {
  const result = previewMusic06PlannerInfluenceShadow({
    candidates: [candidate("a", "A"), candidate("b", "B"), candidate("c", "C")],
    projection: projection({
      artists: [artistProjection({ negativeTracks: 1 })],
    }),
  });

  assert.equal(result.artistProjectionInfluenceCount, 0);
  assert.equal(result.influencedCandidateCount, 0);
});

test("Gate 5 preserves PODCAST positions and only reorders MUSIC subsequence", () => {
  const result = previewMusic06PlannerInfluenceShadow({
    candidates: [
      candidate("a", "A"),
      podcast("pod"),
      candidate("b", "B"),
      candidate("c", "C"),
      candidate("d", "D"),
    ],
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
  });

  assert.deepEqual(result.hypotheticalCandidates.map((row) => row.candidateKey), [
    "a",
    "pod",
    "c",
    "d",
    "b",
  ]);
  assert.equal(result.hypotheticalCandidates[1]?.type, "PODCAST");
});

test("Gate 5 never removes or hard-excludes a candidate", () => {
  const candidates = [candidate("a", "A"), candidate("b", "B"), candidate("c", "C")];
  const result = previewMusic06PlannerInfluenceShadow({
    candidates,
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
  });

  assert.equal(result.inputCandidateCount, 3);
  assert.equal(result.outputCandidateCount, 3);
  assert.deepEqual(
    new Set(result.hypotheticalCandidates.map((row) => row.candidateKey)),
    new Set(candidates.map((row) => row.candidateKey)),
  );
});

test("Gate 5 shadow is deterministic for identical projection/candidate inputs", () => {
  const input = {
    candidates: [candidate("a", "A"), candidate("b", "B"), candidate("c", "C"), candidate("d", "D")],
    projection: projection({ tracks: [trackProjection({ trackName: "B" })] }),
  };
  const left = previewMusic06PlannerInfluenceShadow(input);
  const right = previewMusic06PlannerInfluenceShadow(input);
  assert.deepEqual(left, right);
});

test("Gate 5 validates configurable rank-shift policy fail-closed", () => {
  assert.throws(
    () =>
      previewMusic06PlannerInfluenceShadow({
        candidates: [],
        projection: projection(),
        config: {
          ...DEFAULT_MUSIC_06_PLANNER_INFLUENCE_SHADOW_CONFIG,
          maxCombinedMusicRankShift: -1,
        },
      }),
    /maxCombinedMusicRankShift must be a non-negative integer/,
  );
});
