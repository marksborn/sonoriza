import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner";

import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import {
  applyFirstPartyPlaybackPreferencesToMusicCandidates,
  firstPartySpotifyArtistSubjectKey,
  firstPartySpotifyTrackSubjectKey,
} from "./first-party-planner-preferences";

const NOW = new Date("2026-09-02T19:30:00.000Z");

function music(
  spotifyTrackId: string,
  primaryArtistId: string,
  title = spotifyTrackId,
): Candidate {
  return {
    uri: `spotify:track:${spotifyTrackId}`,
    type: "MUSIC",
    title,
    spotifyTrackId,
    primaryArtistId,
    primaryArtistName: primaryArtistId,
    durationMs: 180_000,
  };
}

function preference(
  input: Partial<FirstPartyPlaybackPreference> &
    Pick<FirstPartyPlaybackPreference, "subjectType" | "subjectKey" | "policy">,
): FirstPartyPlaybackPreference {
  return {
    id: input.id ?? `${input.subjectType}:${input.subjectKey}`,
    userId: input.userId ?? "user-1",
    subjectType: input.subjectType,
    subjectKey: input.subjectKey,
    policy: input.policy,
    source: input.source ?? "USER_EXPLICIT",
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.updatedAt ?? NOW,
  };
}

test("PREFERRED and REDUCED reorder candidates stably without behavioral history", () => {
  const input = [
    music("track-a", "artist-a"),
    music("track-b", "artist-b"),
    music("track-c", "artist-c"),
    music("track-d", "artist-d"),
  ];

  const result = applyFirstPartyPlaybackPreferencesToMusicCandidates(input, [
    preference({
      subjectType: "TRACK",
      subjectKey: firstPartySpotifyTrackSubjectKey("track-c"),
      policy: "PREFERRED",
    }),
    preference({
      subjectType: "ARTIST",
      subjectKey: firstPartySpotifyArtistSubjectKey("artist-a"),
      policy: "REDUCED",
    }),
  ]);

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.spotifyTrackId),
    ["track-c", "track-b", "track-d", "track-a"],
  );
  assert.equal(result.evidence.preferredCandidateCount, 1);
  assert.equal(result.evidence.reducedCandidateCount, 1);
  assert.equal(result.evidence.excludedCandidateCount, 0);
});

test("ARTIST EXCLUDED is a hard veto even when a matching TRACK is PREFERRED", () => {
  const result = applyFirstPartyPlaybackPreferencesToMusicCandidates(
    [music("track-a", "artist-a"), music("track-b", "artist-b")],
    [
      preference({
        subjectType: "ARTIST",
        subjectKey: firstPartySpotifyArtistSubjectKey("artist-a"),
        policy: "EXCLUDED",
      }),
      preference({
        subjectType: "TRACK",
        subjectKey: firstPartySpotifyTrackSubjectKey("track-a"),
        policy: "PREFERRED",
      }),
    ],
  );

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.spotifyTrackId),
    ["track-b"],
  );
  assert.equal(result.evidence.excludedCandidateCount, 1);
});

test("TRACK NORMAL restores a track from ARTIST REDUCED", () => {
  const result = applyFirstPartyPlaybackPreferencesToMusicCandidates(
    [music("track-a", "artist-a"), music("track-b", "artist-b")],
    [
      preference({
        subjectType: "ARTIST",
        subjectKey: firstPartySpotifyArtistSubjectKey("artist-a"),
        policy: "REDUCED",
      }),
      preference({
        subjectType: "TRACK",
        subjectKey: firstPartySpotifyTrackSubjectKey("track-a"),
        policy: "NORMAL",
      }),
    ],
  );

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.spotifyTrackId),
    ["track-a", "track-b"],
  );
  assert.equal(result.evidence.normalCandidateCount, 2);
});

test("VERSION_TRAIT/DISCOVERY/REPEAT remain non-productive in Gate 5B", () => {
  const result = applyFirstPartyPlaybackPreferencesToMusicCandidates(
    [music("track-live", "artist-a", "Song (Live)")],
    [
      preference({
        subjectType: "VERSION_TRAIT",
        subjectKey: "live",
        policy: "EXCLUDED",
      }),
      preference({
        subjectType: "DISCOVERY",
        subjectKey: "global",
        policy: "PREFERRED",
      }),
      preference({
        subjectType: "REPEAT",
        subjectKey: "global",
        policy: "REDUCED",
      }),
    ],
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.evidence.applicablePreferenceCount, 0);
  assert.equal(result.evidence.unsupportedPreferenceCount, 3);
});

test("identity matching is exact and never inferred from title or artist name", () => {
  const result = applyFirstPartyPlaybackPreferencesToMusicCandidates(
    [music("track-a", "artist-a", "Artist B - Favorite")],
    [
      preference({
        subjectType: "ARTIST",
        subjectKey: firstPartySpotifyArtistSubjectKey("artist-b"),
        policy: "EXCLUDED",
      }),
    ],
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.evidence.artistPreferenceMatchCount, 0);
});

test("forged provider source fails closed before planner application", () => {
  const forged = preference({
    subjectType: "TRACK",
    subjectKey: firstPartySpotifyTrackSubjectKey("track-a"),
    policy: "EXCLUDED",
    source: "SPOTIFY" as FirstPartyPlaybackPreference["source"],
  });

  assert.throws(
    () =>
      applyFirstPartyPlaybackPreferencesToMusicCandidates(
        [music("track-a", "artist-a")],
        [forged],
      ),
    /Not a first-party preference source: SPOTIFY/,
  );
});
