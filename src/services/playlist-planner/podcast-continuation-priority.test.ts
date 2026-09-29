import assert from "node:assert/strict";
import test from "node:test";

import { projectPodcastContinuationPriority } from "./podcast-continuation-priority";
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

test("Gate 3.1 fails closed without current destination evidence", () => {
  const candidates = [
    podcast("new"),
    podcast("resume", { podcastListeningStatus: "IN_PROGRESS" }),
  ];

  const result = projectPodcastContinuationPriority({ candidates });

  assert.deepEqual(result.candidates, candidates);
  assert.equal(result.continuationCandidateCount, 0);
  assert.equal(result.selectedEpisodeId, null);
});

test("Gate 3.1 ignores IN_PROGRESS episodes that are not already in the destination", () => {
  const candidates = [
    podcast("new"),
    podcast("resume", { podcastListeningStatus: "IN_PROGRESS" }),
  ];

  const result = projectPodcastContinuationPriority({
    candidates,
    currentDestinationEpisodeIds: ["old-other"],
  });

  assert.deepEqual(result.candidates, candidates);
  assert.equal(result.continuationCandidateCount, 0);
  assert.equal(result.selectedEpisodeId, null);
});

test("Gate 3.1 promotes one destination-local IN_PROGRESS episode", () => {
  const candidates = [
    podcast("priority-new"),
    podcast("resume", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("normal-new"),
  ];

  const result = projectPodcastContinuationPriority({
    candidates,
    currentDestinationEpisodeIds: ["resume"],
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

test("Gate 3.1 selects only the first eligible IN_PROGRESS episode in previous destination order", () => {
  const candidates = [
    podcast("new-a"),
    podcast("later-in-destination", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("earlier-in-destination", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("new-b"),
  ];

  const result = projectPodcastContinuationPriority({
    candidates,
    currentDestinationEpisodeIds: [
      "earlier-in-destination",
      "later-in-destination",
    ],
  });

  assert.equal(result.continuationCandidateCount, 2);
  assert.deepEqual(result.promotedEpisodeIds, ["earlier-in-destination"]);
  assert.equal(result.selectedEpisodeId, "earlier-in-destination");
  assert.deepEqual(result.candidates.map((candidate) => candidate.spotifyEpisodeId), [
    "earlier-in-destination",
    "new-a",
    "later-in-destination",
    "new-b",
  ]);
});

test("Gate 3.1 does not promote a destination episode that is no longer IN_PROGRESS", () => {
  const candidates = [podcast("candidate"), podcast("other")];

  const result = projectPodcastContinuationPriority({
    candidates,
    currentDestinationEpisodeIds: ["candidate"],
  });

  assert.deepEqual(result.candidates, candidates);
  assert.equal(result.continuationCandidateCount, 0);
});

test("Gate 3.1 fails closed for IN_PROGRESS candidate without episode identity", () => {
  const unidentified = podcast("missing-id", {
    spotifyEpisodeId: undefined,
    podcastListeningStatus: "IN_PROGRESS",
  });
  const candidates = [podcast("new"), unidentified, podcast("later")];

  const result = projectPodcastContinuationPriority({
    candidates,
    currentDestinationEpisodeIds: ["missing-id"],
  });

  assert.deepEqual(result.candidates, candidates);
  assert.equal(result.continuationCandidateCount, 0);
});

test("Gate 3.1 preserves non-podcast positions while moving only the selected continuation", () => {
  const candidates = [
    podcast("priority-a"),
    music("song-a"),
    podcast("resume", { podcastListeningStatus: "IN_PROGRESS" }),
    podcast("priority-b"),
    music("song-b"),
    podcast("other-progress", { podcastListeningStatus: "IN_PROGRESS" }),
  ];

  const result = projectPodcastContinuationPriority({
    candidates,
    currentDestinationEpisodeIds: ["resume", "other-progress"],
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.uri), [
    "spotify:episode:resume",
    "spotify:track:song-a",
    "spotify:episode:priority-a",
    "spotify:episode:priority-b",
    "spotify:track:song-b",
    "spotify:episode:other-progress",
  ]);
  assert.deepEqual(result.promotedEpisodeIds, ["resume"]);
  assert.equal(result.candidates[1], candidates[1]);
  assert.equal(result.candidates[4], candidates[4]);
});
