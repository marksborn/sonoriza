import assert from "node:assert/strict";
import test from "node:test";

import { planPlaylist, type Candidate } from "@/services/playlist-planner";

import {
  buildDiscoveryPlannerMusicPool,
  DISCOVERY_PLANNER_PREVIEW_POLICY_V1,
} from "./planner-bridge";
import type {
  DiscoveryGate22ScoringReport,
  DiscoveryGate22TrackCandidate,
} from "./scoring-gate2-2";
import type { DiscoveryTrackIdentityEvidence } from "./track-identity";

function music(
  id: string,
  title: string,
  artist: string,
  input: Partial<Candidate> = {},
): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title,
    subtitle: artist,
    spotifyTrackId: id,
    primaryArtistId: input.primaryArtistId ?? `artist:${artist}`,
    primaryArtistName: artist,
    albumId: input.albumId ?? `album:${id}`,
    albumName: input.albumName ?? "Album",
    durationMs: input.durationMs ?? 180_000,
    ...input,
  };
}

function scored(
  category: "FAMILIAR" | "REDESCOBERTA",
  id: string,
  title: string,
  artist: string,
  score: number,
): DiscoveryGate22TrackCandidate {
  return {
    category,
    spotifyTrackId: id,
    trackName: title,
    artistName: artist,
    score,
    eligible: true,
    components: {
      trackHistoricalStrength: 0.8,
      artistHistoricalAffinity: 0.8,
      artistRecentAffinity: 0.2,
      dormancy: category === "REDESCOBERTA" ? 0.9 : 0,
      adjustedExplicitSkipRate: 0.1,
      negativePenalty: 0,
    },
    reasons: [],
  };
}

function report(input: {
  familiar?: DiscoveryGate22TrackCandidate[];
  rediscovery?: DiscoveryGate22TrackCandidate[];
  selectionReady?: boolean;
} = {}): DiscoveryGate22ScoringReport {
  return {
    version: "gate2.2-v1",
    generatedAt: new Date("2026-08-20T18:00:00.000Z"),
    calibration: {} as DiscoveryGate22ScoringReport["calibration"],
    selectionPolicy: {
      candidateUniverse: input.selectionReady === false ? "DIAGNOSTIC_PARTIAL" : "COMPLETE",
      selectionReady: input.selectionReady !== false,
      categoryBudgetRule: "CEILING_NOT_QUOTA",
      trackCategoryPrecedence: ["REDESCOBERTA", "FAMILIAR"],
      rediscoveryPreemptedFamiliarCount: 0,
      minimumScores: {} as DiscoveryGate22ScoringReport["selectionPolicy"]["minimumScores"],
      recordingIdentityPolicy: "ISRC_THEN_CONSERVATIVE_ARTIST_TITLE",
      rediscoveryPreemptedFamiliarBySpotifyIdCount: 0,
      rediscoveryPreemptedFamiliarByRecordingIdentityCount: 0,
      recordingIdentityMatchSources: {
        ISRC: 0,
        SPOTIFY_PRIMARY_ARTIST_TITLE: 0,
        CANONICAL_ARTIST_TITLE: 0,
      },
    },
    topArtistAffinity: [],
    familiarCandidates: input.familiar ?? [],
    rediscoveryCandidates: input.rediscovery ?? [],
    rediscoveryReturns: [],
    deepeningCandidates: [],
    externalDiscovery: {
      status: "READY_FOR_CANDIDATES",
      note: "test",
    },
  };
}

function identity(
  spotifyTrackId: string,
  input: Partial<DiscoveryTrackIdentityEvidence> = {},
): DiscoveryTrackIdentityEvidence {
  return {
    spotifyTrackId,
    isrc: input.isrc ?? null,
    primaryArtistId: input.primaryArtistId ?? null,
    isrcConflict: input.isrcConflict ?? false,
    primaryArtistIdConflict: input.primaryArtistIdConflict ?? false,
  };
}

test("rejects diagnostic partial scoring before planner selection", () => {
  assert.throws(
    () =>
      buildDiscoveryPlannerMusicPool({
        report: report({ selectionReady: false }),
        music: [music("a", "A", "Artist")],
        trackIdentities: [],
      }),
    /candidateUniverse=COMPLETE/,
  );
});

test("orders FAMILIAR by score and spaces REDESCOBERTA under the preview prefix ceiling", () => {
  const source = [
    music("r1", "Rediscovery 1", "Old"),
    music("f3", "Familiar 3", "Known"),
    music("f1", "Familiar 1", "Known"),
    music("r2", "Rediscovery 2", "Old"),
    music("f2", "Familiar 2", "Known"),
    music("fallback", "Source only", "New"),
  ];
  const result = buildDiscoveryPlannerMusicPool({
    report: report({
      familiar: [
        scored("FAMILIAR", "f1", "Familiar 1", "Known", 90),
        scored("FAMILIAR", "f2", "Familiar 2", "Known", 80),
        scored("FAMILIAR", "f3", "Familiar 3", "Known", 70),
      ],
      rediscovery: [
        scored("REDESCOBERTA", "r1", "Rediscovery 1", "Old", 95),
        scored("REDESCOBERTA", "r2", "Rediscovery 2", "Old", 85),
      ],
    }),
    music: source,
    trackIdentities: [],
  });

  assert.equal(DISCOVERY_PLANNER_PREVIEW_POLICY_V1.rediscoveryCeiling, 0.25);
  assert.deepEqual(
    result.entries.slice(0, 5).map((entry) => [entry.category, entry.candidate.spotifyTrackId]),
    [
      ["FAMILIAR", "f1"],
      ["FAMILIAR", "f2"],
      ["FAMILIAR", "f3"],
      ["REDESCOBERTA", "r1"],
      ["SOURCE_FALLBACK", "fallback"],
    ],
  );
  assert.equal(result.evidence.rediscoveryCeiling, 0.25);
});

test("cross-release source candidate inherits REDESCOBERTA before FAMILIAR", () => {
  const source = music("new-release", "Sun Doesn't Rise", "Mushroomhead", {
    primaryArtistId: "mushroomhead",
  });
  const result = buildDiscoveryPlannerMusicPool({
    report: report({
      familiar: [scored("FAMILIAR", "other", "Other", "Mushroomhead", 70)],
      rediscovery: [
        scored(
          "REDESCOBERTA",
          "old-release",
          "Sun Doesn't Rise",
          "Mushroomhead",
          83.2,
        ),
      ],
    }),
    music: [source, music("f", "Known", "Known")],
    trackIdentities: [
      identity("new-release", { primaryArtistId: "mushroomhead" }),
      identity("old-release", { primaryArtistId: "mushroomhead" }),
    ],
    rediscoveryCeiling: 1,
  });

  const entry = result.entries.find(
    (candidate) => candidate.candidate.spotifyTrackId === "new-release",
  );
  assert.equal(entry?.category, "REDESCOBERTA");
  assert.equal(entry?.matchedScoreTrackId, "old-release");
  assert.equal(entry?.matchSource, "SPOTIFY_PRIMARY_ARTIST_TITLE");
  assert.equal(result.evidence.crossReleaseMatchedCount, 1);
});

test("dedupes two source releases of the same recording but keeps different authoritative ISRCs", () => {
  const sameA = music("same-a", "Song", "Artist", { primaryArtistId: "artist-1" });
  const sameB = music("same-b", "Song", "Artist", { primaryArtistId: "artist-1" });
  const other = music("other", "Song", "Artist", { primaryArtistId: "artist-1" });

  const result = buildDiscoveryPlannerMusicPool({
    report: report(),
    music: [sameA, sameB, other],
    trackIdentities: [
      identity("same-a", { isrc: "USAAA1111111", primaryArtistId: "artist-1" }),
      identity("same-b", { isrc: "USAAA1111111", primaryArtistId: "artist-1" }),
      identity("other", { isrc: "USBBB2222222", primaryArtistId: "artist-1" }),
    ],
  });

  assert.deepEqual(
    result.music.map((candidate) => candidate.spotifyTrackId),
    ["same-a", "other"],
  );
  assert.equal(result.evidence.duplicateRecordingDroppedCount, 1);
});

test("unscored source candidates remain available in original order", () => {
  const result = buildDiscoveryPlannerMusicPool({
    report: report({
      familiar: [scored("FAMILIAR", "f", "Familiar", "Known", 80)],
    }),
    music: [
      music("z", "Source Z", "Source"),
      music("f", "Familiar", "Known"),
      music("a", "Source A", "Source"),
    ],
    trackIdentities: [],
  });

  assert.deepEqual(
    result.entries.map((entry) => entry.candidate.spotifyTrackId),
    ["f", "z", "a"],
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.category),
    ["FAMILIAR", "SOURCE_FALLBACK", "SOURCE_FALLBACK"],
  );
});

test("existing planner consumes the DISCOVERY-ranked pool without a second planner", () => {
  const source = [
    music("source-first", "Source first", "Source", { durationMs: 180_000 }),
    music("best", "Best familiar", "Known", { durationMs: 180_000 }),
  ];
  const bridge = buildDiscoveryPlannerMusicPool({
    report: report({
      familiar: [scored("FAMILIAR", "best", "Best familiar", "Known", 95)],
    }),
    music: source,
    trackIdentities: [],
  });
  const planned = planPlaylist({
    rules: {
      targetDurationMs: 180_000,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
      maxEpisodesPerProgram: 1,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
    pools: { music: bridge.music, podcasts: [] },
  });

  assert.equal(planned.items.length, 1);
  assert.equal(planned.items[0]?.spotifyTrackId, "best");
});
