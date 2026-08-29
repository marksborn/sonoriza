import assert from "node:assert/strict";
import test from "node:test";

import {
  rankProbableLikeAggregates,
  type ProbableLikeAggregate,
} from "./probable-like";
import { probableLikeTrackIdentityKey } from "./probable-like-spotify-identity";

const now = new Date("2026-08-29T12:00:00.000Z");

function aggregate(
  overrides: Partial<ProbableLikeAggregate> &
    Pick<ProbableLikeAggregate, "spotifyTrackId">,
): ProbableLikeAggregate {
  return {
    spotifyTrackId: overrides.spotifyTrackId,
    trackName: overrides.trackName ?? `Track ${overrides.spotifyTrackId}`,
    artistName: overrides.artistName ?? "Artist",
    playCount: overrides.playCount ?? 6,
    distinctDays: overrides.distinctDays ?? 4,
    factualCompleteCount: overrides.factualCompleteCount ?? 3,
    factualSkipCount: overrides.factualSkipCount ?? 0,
    knownTrackDurationMs: overrides.knownTrackDurationMs ?? null,
    maxFactualCompleteMsPlayed:
      overrides.maxFactualCompleteMsPlayed ?? 180_000,
    firstPlayedAt:
      overrides.firstPlayedAt ?? new Date("2026-07-01T12:00:00.000Z"),
    lastPlayedAt:
      overrides.lastPlayedAt ?? new Date("2026-08-28T12:00:00.000Z"),
  };
}

test("explicitly liked tracks never enter probable-like shadow ranking", () => {
  const result = rankProbableLikeAggregates({
    aggregates: [aggregate({ spotifyTrackId: "liked" })],
    likedTrackIds: new Set(["liked"]),
    now,
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.excludedLikedCount, 1);
});

test("relinked historical id stays excluded when current Spotify like has same track and artist", () => {
  const relinked = aggregate({
    spotifyTrackId: "historical-id",
    trackName: "Light the Torch",
    artistName: "Soilwork",
  });
  const identityKey = probableLikeTrackIdentityKey(relinked);
  assert.ok(identityKey);

  const result = rankProbableLikeAggregates({
    aggregates: [relinked],
    likedTrackIds: new Set(["current-spotify-id"]),
    likedTrackIdentityKeys: new Set([identityKey]),
    now,
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.excludedLikedCount, 1);
});

test("repeated multi-day factual completion produces explainable candidate", () => {
  const result = rankProbableLikeAggregates({
    aggregates: [aggregate({ spotifyTrackId: "candidate" })],
    likedTrackIds: new Set(),
    now,
  });

  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.spotifyTrackId, "candidate");
  assert.ok(candidate.score > 0);
  assert.ok(candidate.reasons.some((reason) => reason.includes("6 vezes")));
  assert.ok(candidate.reasons.some((reason) => reason.includes("3 conclusões factuais")));
});

test("inferred completion can support a candidate but is weighted below factual", () => {
  const inferredOnly = aggregate({
    spotifyTrackId: "inferred",
    factualCompleteCount: 0,
    maxFactualCompleteMsPlayed: null,
    playCount: 4,
    distinctDays: 3,
  });
  const factual = aggregate({
    spotifyTrackId: "factual",
    factualCompleteCount: 2,
    playCount: 4,
    distinctDays: 3,
  });

  const result = rankProbableLikeAggregates({
    aggregates: [inferredOnly, factual],
    likedTrackIds: new Set(),
    inferredCompleteCounts: new Map([["inferred", 2]]),
    now,
  });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]!.spotifyTrackId, "factual");
  const inferred = result.candidates.find(
    (candidate) => candidate.spotifyTrackId === "inferred",
  );
  assert.ok(inferred);
  assert.ok(
    inferred.reasons.some((reason) => reason.includes("2 conclusões inferidas")),
  );
});

test("strong repeated negative evidence excludes a track", () => {
  const result = rankProbableLikeAggregates({
    aggregates: [
      aggregate({
        spotifyTrackId: "negative",
        playCount: 6,
        factualSkipCount: 2,
      }),
    ],
    likedTrackIds: new Set(),
    inferredSkipCounts: new Map([["negative", 1]]),
    now,
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.excludedStrongNegativeCount, 1);
});

test("single-day repetition is not enough for probable-like ranking", () => {
  const result = rankProbableLikeAggregates({
    aggregates: [
      aggregate({
        spotifyTrackId: "one-day",
        playCount: 12,
        distinctDays: 1,
        factualCompleteCount: 10,
      }),
    ],
    likedTrackIds: new Set(),
    now,
  });

  assert.equal(result.candidates.length, 0);
});

test("known catalog duration excludes ultra-short utility content", () => {
  const result = rankProbableLikeAggregates({
    aggregates: [
      aggregate({
        spotifyTrackId: "utility-known",
        playCount: 38,
        distinctDays: 31,
        factualCompleteCount: 31,
        knownTrackDurationMs: 6_000,
        maxFactualCompleteMsPlayed: 6_000,
      }),
    ],
    likedTrackIds: new Set(),
    now,
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.excludedShortContentCount, 1);
});

test("repeated factual completions provide conservative historical short-content fallback", () => {
  const result = rankProbableLikeAggregates({
    aggregates: [
      aggregate({
        spotifyTrackId: "utility-historical",
        playCount: 38,
        distinctDays: 31,
        factualCompleteCount: 31,
        knownTrackDurationMs: null,
        maxFactualCompleteMsPlayed: 6_500,
      }),
    ],
    likedTrackIds: new Set(),
    now,
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.excludedShortContentCount, 1);
});

test("one short tail completion does not classify an otherwise unknown track as utility", () => {
  const result = rankProbableLikeAggregates({
    aggregates: [
      aggregate({
        spotifyTrackId: "tail-only",
        factualCompleteCount: 1,
        knownTrackDurationMs: null,
        maxFactualCompleteMsPlayed: 6_000,
      }),
    ],
    likedTrackIds: new Set(),
    now,
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.excludedShortContentCount, 0);
});
