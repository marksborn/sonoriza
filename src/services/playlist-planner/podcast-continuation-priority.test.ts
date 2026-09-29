import assert from "node:assert/strict";
import test from "node:test";

import {
  projectPodcastContinuationPriority,
  type PodcastContinuationListeningState,
} from "./podcast-continuation-priority";
import type { Candidate } from "./types";

function podcast(
  id: string,
  options: Partial<Candidate> = {},
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId: `show:${id}`,
    durationMs: 30 * 60_000,
    podcastListeningStatus: "NOT_STARTED",
    ...options,
  };
}

function music(id: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    durationMs: 3 * 60_000,
  };
}

function state(
  episodeId: string,
  options: Partial<PodcastContinuationListeningState> = {},
): PodcastContinuationListeningState {
  return {
    spotifyEpisodeId: episodeId,
    status: "IN_PROGRESS",
    lastObservedAt: null,
    firstProgressObservedAt: null,
    ...options,
  };
}

test("Gate 2 is a strict no-op when there is no IN_PROGRESS candidate", () => {
  const candidates = [podcast("priority"), podcast("normal"), music("song")];

  const result = projectPodcastContinuationPriority({ candidates });

  assert.deepEqual(result.candidates, candidates);
  assert.equal(result.continuationCandidateCount, 0);
  assert.deepEqual(result.promotedEpisodeIds, []);
  assert.equal(result.selectedEpisodeId, null);
  assert.equal(result.movedCount, 0);
});

test("Gate 2 promotes one IN_PROGRESS episode ahead of already ordered new episodes", () => {
  const candidates = [
    podcast("priority-new"),
    podcast("resume", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("normal-new"),
  ];

  const result = projectPodcastContinuationPriority({
    candidates,
    listeningStates: [
      state("resume", { lastObservedAt: new Date("2026-09-29T10:00:00Z") }),
    ],
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.spotifyEpisodeId), [
    "resume",
    "priority-new",
    "normal-new",
  ]);
  assert.equal(result.continuationCandidateCount, 1);
  assert.deepEqual(result.promotedEpisodeIds, ["resume"]);
  assert.equal(result.selectedEpisodeId, "resume");
});

test("Gate 2 orders multiple IN_PROGRESS episodes by lastObservedAt descending", () => {
  const candidates = [
    podcast("older", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("new", { podcastListeningStatus: "NOT_STARTED" }),
    podcast("newer", { podcastListeningStatus: "IN_PROGRESS" }),
  ];

  const result = projectPodcastContinuationPriority({
    candidates,
    listeningStates: [
      state("older", { lastObservedAt: new Date("2026-09-28T20:00:00Z") }),
      state("newer", { lastObservedAt: new Date("2026-09-29T09:00:00Z") }),
    ],
  });

  assert.deepEqual(result.promotedEpisodeIds, ["newer", "older"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.spotifyEpisodeId), [
    "newer",
    "older",
    "new",
  ]);
  assert.equal(result.selectedEpisodeId, "newer");
});

test("Gate 2 uses firstProgressObservedAt as deterministic fallback", () => {
  const candidates = [
    podcast("earlier-progress", {
      podcastListeningStatus: "IN_PROGRESS",
      podcastFirstProgressObservedAt: new Date("2026-09-27T08:00:00Z"),
    }),
    podcast("later-progress", {
      podcastListeningStatus: "IN_PROGRESS",
      podcastFirstProgressObservedAt: new Date("2026-09-28T08:00:00Z"),
    }),
  ];

  const result = projectPodcastContinuationPriority({ candidates });

  assert.deepEqual(result.promotedEpisodeIds, ["later-progress", "earlier-progress"]);
});

test("Gate 2 preserves original order when continuation recency is tied or absent", () => {
  const candidates = [
    podcast("first", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("second", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("third"),
  ];

  const result = projectPodcastContinuationPriority({ candidates });

  assert.deepEqual(result.candidates, candidates);
  assert.deepEqual(result.promotedEpisodeIds, ["first", "second"]);
  assert.equal(result.movedCount, 0);
});

test("Gate 2 fails closed for IN_PROGRESS candidate without episode identity", () => {
  const unidentified = podcast("missing-id", {
    spotifyEpisodeId: undefined,
    podcastListeningStatus: "IN_PROGRESS",
  });
  const candidates = [podcast("new"), unidentified, podcast("later")];

  const result = projectPodcastContinuationPriority({ candidates });

  assert.deepEqual(result.candidates, candidates);
  assert.equal(result.continuationCandidateCount, 0);
  assert.deepEqual(result.promotedEpisodeIds, []);
});

test("Gate 2 does not use external state to resurrect a non-IN_PROGRESS candidate", () => {
  const candidates = [podcast("candidate"), podcast("other")];

  const result = projectPodcastContinuationPriority({
    candidates,
    listeningStates: [
      state("candidate", { lastObservedAt: new Date("2026-09-29T10:00:00Z") }),
    ],
  });

  assert.deepEqual(result.candidates, candidates);
  assert.equal(result.continuationCandidateCount, 0);
});

test("Gate 2 keeps all non-continuation candidates in their existing relative order", () => {
  const candidates = [
    podcast("priority-a"),
    music("song-a"),
    podcast("resume", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("priority-b"),
    music("song-b"),
    podcast("normal"),
  ];

  const result = projectPodcastContinuationPriority({ candidates });

  assert.deepEqual(result.candidates.map((candidate) => candidate.uri), [
    "spotify:episode:resume",
    "spotify:episode:priority-a",
    "spotify:track:song-a",
    "spotify:episode:priority-b",
    "spotify:track:song-b",
    "spotify:episode:normal",
  ]);
});
