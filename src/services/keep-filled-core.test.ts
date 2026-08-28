import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, PlaylistRules } from "@/services/playlist-planner";

import {
  buildKeepFilledPreservation,
  type CurrentTargetPlaylistItem,
} from "./keep-filled-core";

const baseRules: Pick<
  PlaylistRules,
  | "compositionMode"
  | "sequencePattern"
  | "maxEpisodesPerProgram"
  | "maxTracksPerArtist"
  | "maxTracksPerAlbum"
> = {
  compositionMode: "PROPORTION",
  sequencePattern: ["MUSIC", "PODCAST"],
  maxEpisodesPerProgram: 2,
  maxTracksPerArtist: null,
  maxTracksPerAlbum: null,
};

function music(
  position: number,
  id: string,
  artist = `artist-${id}`,
  album = `album-${id}`,
): CurrentTargetPlaylistItem {
  const candidate: Candidate = {
    uri: `spotify:track:${id}`,
    spotifyTrackId: id,
    type: "MUSIC",
    title: id,
    primaryArtistId: artist,
    albumId: album,
    durationMs: 180_000,
  };
  return {
    position,
    uri: candidate.uri,
    type: "MUSIC",
    musicCandidate: candidate,
    originalDurationMs: candidate.durationMs,
    removableByUri: true,
  };
}

function podcast(
  position: number,
  id: string,
  programId = "show-1",
): CurrentTargetPlaylistItem {
  return {
    position,
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    spotifyEpisodeId: id,
    programId,
    title: id,
    originalDurationMs: 3_600_000,
    providerResumePositionMs: 0,
    providerFullyPlayed: false,
    removableByUri: true,
  };
}

function build(
  overrides: Partial<Parameters<typeof buildKeepFilledPreservation>[0]> = {},
) {
  return buildKeepFilledPreservation({
    items: [music(0, "m1"), podcast(1, "p1")],
    podcastStates: new Map([
      [
        "p1",
        {
          status: "NOT_STARTED" as const,
          durationMs: 3_600_000,
          resumePositionMs: 0,
        },
      ],
    ]),
    provenanceByUri: new Map([
      ["spotify:episode:p1", { sourceIncludePlayed: false }],
    ]),
    musicRepeatEnabled: false,
    blockedTrackIds: new Set(),
    rules: baseRules,
    maxPodcastDurationMs: null,
    ...overrides,
  });
}

test("KEEP_FILLED preserves valid current content and its effective duration", () => {
  const result = build();
  assert.deepEqual(
    result.preserved.map((item) => item.uri),
    ["spotify:track:m1", "spotify:episode:p1"],
  );
  assert.equal(result.validDurationBeforeMs, 3_780_000);
  assert.equal(result.removedCount, 0);
  assert.equal(result.forceReplace, false);
});

test("completed podcast with includePlayed=false stops occupying duration", () => {
  const result = build({
    podcastStates: new Map([
      [
        "p1",
        {
          status: "COMPLETED",
          durationMs: 3_600_000,
          resumePositionMs: 3_500_000,
        },
      ],
    ]),
  });
  assert.deepEqual(result.preserved.map((item) => item.uri), ["spotify:track:m1"]);
  assert.deepEqual(result.removeUris, ["spotify:episode:p1"]);
  assert.equal(result.removals[0]?.reason, "PODCAST_COMPLETED_NO_REPLAY");
});

test("in-progress podcast contributes only remaining time", () => {
  const result = build({
    podcastStates: new Map([
      [
        "p1",
        {
          status: "IN_PROGRESS",
          durationMs: 3_600_000,
          resumePositionMs: 1_200_000,
        },
      ],
    ]),
  });
  const kept = result.preserved.find((item) => item.type === "PODCAST");
  assert.equal(kept?.durationMs, 2_400_000);
  assert.equal(result.validDurationBeforeMs, 2_580_000);
});

test("completed podcast explicitly allowed for replay remains valid", () => {
  const result = build({
    provenanceByUri: new Map([
      [
        "spotify:episode:p1",
        {
          sourceIncludePlayed: true,
          sourceSpotifyType: "SHOW",
          sourceSpotifyId: "show-1",
        },
      ],
    ]),
    podcastStates: new Map([
      [
        "p1",
        {
          status: "COMPLETED",
          durationMs: 3_600_000,
          resumePositionMs: 3_600_000,
        },
      ],
    ]),
  });
  const kept = result.preserved.find((item) => item.type === "PODCAST");
  assert.equal(kept?.durationMs, 3_600_000);
  assert.equal(kept?.sourceIncludePlayed, true);
});

test("current SHOW policy overrides stale replay provenance", () => {
  const result = build({
    provenanceByUri: new Map([
      [
        "spotify:episode:p1",
        {
          sourceIncludePlayed: false,
          sourceSpotifyType: "SHOW",
          sourceSpotifyId: "show-1",
        },
      ],
    ]),
    podcastShowPolicyByUri: new Map([
      [
        "spotify:episode:p1",
        { replayAllowed: true, maxEpisodesPerCycle: 1 },
      ],
    ]),
    podcastStates: new Map([
      [
        "p1",
        {
          status: "COMPLETED",
          durationMs: 3_600_000,
          resumePositionMs: 3_600_000,
        },
      ],
    ]),
  });

  const kept = result.preserved.find((item) => item.type === "PODCAST");
  assert.equal(kept?.sourceIncludePlayed, true);
  assert.equal(kept?.podcastMaxEpisodesPerCycle, 1);
});

test("stale SHOW episode is not preserved by KEEP_FILLED", () => {
  const result = build({
    podcastShowPolicyByUri: new Map([
      [
        "spotify:episode:p1",
        {
          replayAllowed: false,
          maxEpisodesPerCycle: 1,
          blockedReason: "PODCAST_SHOW_RELEASE_EXPIRED",
        },
      ],
    ]),
  });

  assert.deepEqual(result.preserved.map((item) => item.uri), ["spotify:track:m1"]);
  assert.equal(result.removals[0]?.reason, "PODCAST_SHOW_RELEASE_EXPIRED");
  assert.deepEqual(result.removeUris, ["spotify:episode:p1"]);
});

test("SHOW state filter removes an item even if old provenance allowed replay", () => {
  const result = build({
    provenanceByUri: new Map([
      [
        "spotify:episode:p1",
        {
          sourceIncludePlayed: true,
          sourceSpotifyType: "SHOW",
          sourceSpotifyId: "show-1",
        },
      ],
    ]),
    podcastShowPolicyByUri: new Map([
      [
        "spotify:episode:p1",
        {
          replayAllowed: false,
          maxEpisodesPerCycle: 1,
          blockedReason: "PODCAST_SHOW_STATE_FILTERED",
        },
      ],
    ]),
    podcastStates: new Map([
      [
        "p1",
        {
          status: "COMPLETED",
          durationMs: 3_600_000,
          resumePositionMs: 3_600_000,
        },
      ],
    ]),
  });

  assert.equal(result.preserved.length, 1);
  assert.equal(result.removals[0]?.reason, "PODCAST_SHOW_STATE_FILTERED");
});

test("unknown replay provenance is preserved instead of destructively guessed", () => {
  const result = build({
    provenanceByUri: new Map(),
    podcastStates: new Map([
      [
        "p1",
        {
          status: "COMPLETED",
          durationMs: 3_600_000,
          resumePositionMs: 3_600_000,
        },
      ],
    ]),
  });
  assert.equal(result.preserved.length, 2);
  assert.equal(result.unknownReplayPolicyCount, 1);
});

test("recently played music is removed when MUSIC-01 is active", () => {
  const result = build({
    musicRepeatEnabled: true,
    blockedTrackIds: new Set(["m1"]),
  });
  assert.deepEqual(result.preserved.map((item) => item.uri), ["spotify:episode:p1"]);
  assert.equal(result.removals[0]?.reason, "MUSIC_RECENTLY_PLAYED");
});

test("hard podcast duration and program caps are applied to preserved items", () => {
  const result = build({
    items: [podcast(0, "p1"), podcast(1, "p2")],
    podcastStates: new Map([
      [
        "p1",
        { status: "NOT_STARTED", durationMs: 3_600_000, resumePositionMs: 0 },
      ],
      [
        "p2",
        { status: "NOT_STARTED", durationMs: 3_600_000, resumePositionMs: 0 },
      ],
    ]),
    provenanceByUri: new Map([
      ["spotify:episode:p1", { sourceIncludePlayed: false }],
      ["spotify:episode:p2", { sourceIncludePlayed: false }],
    ]),
    rules: { ...baseRules, maxEpisodesPerProgram: 1 },
  });
  assert.equal(result.preserved.length, 1);
  assert.equal(result.removals[0]?.reason, "PODCAST_PROGRAM_LIMIT");

  const duration = build({ maxPodcastDurationMs: 3_000_000 });
  assert.equal(duration.removals[0]?.reason, "PODCAST_DURATION_LIMIT");
});

test("SHOW cap can be stricter than the destination cap for preserved items", () => {
  const result = build({
    items: [podcast(0, "p1"), podcast(1, "p2")],
    podcastStates: new Map([
      [
        "p1",
        { status: "NOT_STARTED", durationMs: 3_600_000, resumePositionMs: 0 },
      ],
      [
        "p2",
        { status: "NOT_STARTED", durationMs: 3_600_000, resumePositionMs: 0 },
      ],
    ]),
    provenanceByUri: new Map([
      ["spotify:episode:p1", { sourceIncludePlayed: false }],
      ["spotify:episode:p2", { sourceIncludePlayed: false }],
    ]),
    podcastShowPolicyByUri: new Map([
      ["spotify:episode:p1", { replayAllowed: false, maxEpisodesPerCycle: 1 }],
      ["spotify:episode:p2", { replayAllowed: false, maxEpisodesPerCycle: 1 }],
    ]),
    rules: { ...baseRules, maxEpisodesPerProgram: 5 },
  });

  assert.equal(result.preserved.length, 1);
  assert.equal(result.removals[0]?.reason, "PODCAST_PROGRAM_LIMIT");
});

test("diversity limits remain hard constraints for preserved music", () => {
  const result = build({
    items: [
      music(0, "m1", "artist-a", "album-a"),
      music(1, "m2", "artist-a", "album-b"),
    ],
    podcastStates: new Map(),
    provenanceByUri: new Map(),
    rules: { ...baseRules, maxTracksPerArtist: 1 },
  });
  assert.equal(result.preserved.length, 1);
  assert.equal(result.removals[0]?.reason, "MUSIC_ARTIST_LIMIT");
});

test("SEQUENCE preserves the longest valid subsequence without reordering it", () => {
  const result = build({
    items: [music(0, "m1"), music(1, "m2"), podcast(2, "p1")],
    rules: {
      ...baseRules,
      compositionMode: "SEQUENCE",
      sequencePattern: ["MUSIC", "PODCAST"],
    },
  });
  assert.deepEqual(
    result.preserved.map((item) => item.uri),
    ["spotify:track:m1", "spotify:episode:p1"],
  );
  assert.equal(result.removals[0]?.reason, "SEQUENCE_TYPE_MISMATCH");
});

test("duplicate URI forces full replacement so URI-delete cannot erase a kept occurrence", () => {
  const duplicate = music(1, "m1");
  const result = build({
    items: [music(0, "m1"), duplicate],
    podcastStates: new Map(),
    provenanceByUri: new Map(),
  });
  assert.equal(result.preserved.length, 1);
  assert.equal(result.forceReplace, true);
  assert.equal(result.removals[0]?.reason, "DUPLICATE_URI");
});
