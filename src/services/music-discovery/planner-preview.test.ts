import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, RunTarget } from "@/services/playlist-planner";

import type { CompleteMusicDiscoveryProfile } from "./complete-profile";
import {
  buildCompleteDiscoveryPlannerPreview,
  collectCompleteDiscoverySourceUniverse,
  type DiscoveryPreviewSource,
} from "./planner-preview";
import { buildMusicDiscoveryProfile, type DiscoveryHistoryEvent } from "./profile";

const AS_OF = new Date("2026-08-20T20:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function music(id: string, artist: string, title: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    spotifyTrackId: id,
    primaryArtistId: `artist:${artist}`,
    primaryArtistName: artist,
    albumId: `album:${artist}`,
    albumName: `${artist} Album`,
    title,
    subtitle: artist,
    durationMs: 180_000,
  };
}

function sourceWithPages(
  id: string,
  kind: "MUSIC" | "PODCAST",
  pages: Candidate[][],
): DiscoveryPreviewSource {
  let index = 0;
  let done = pages.length === 0;
  return {
    id,
    label: id,
    kind,
    get done() {
      return done;
    },
    async readNext() {
      const candidates = pages[index] ?? [];
      index += 1;
      done = index >= pages.length;
      return { candidates, done };
    },
  };
}

function historicalEvent(
  id: string,
  artistName: string,
  trackName: string,
  playedAt: Date,
): DiscoveryHistoryEvent {
  return {
    source: "SPOTIFY_RECENTLY_PLAYED",
    spotifyTrackId: id,
    spotifyUri: `spotify:track:${id}`,
    trackName,
    artistName,
    albumName: `${artistName} Album`,
    playedAt,
    metadata: null,
  };
}

function completeProfile(events: DiscoveryHistoryEvent[]): CompleteMusicDiscoveryProfile {
  const profile = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: null,
    completeUniverse: true,
  });
  return {
    universe: "COMPLETE",
    profile,
    artists: profile.topArtistsHistorical,
    tracks: profile.topTracksHistorical,
  };
}

const TARGET: RunTarget = {
  targetPlaylistId: "target-1",
  name: "Escutar",
  priority: 1,
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
};

test("Gate 3B drains later source pages before the existing planner selects music", async () => {
  const weak = music("weak", "Weak Artist", "Weak Track");
  const strong = music("strong", "Strong Artist", "Strong Track");
  const sourceUniverse = await collectCompleteDiscoverySourceUniverse([
    sourceWithPages("music-source", "MUSIC", [[weak], [strong]]),
  ]);

  const history: DiscoveryHistoryEvent[] = [
    historicalEvent(
      "weak",
      "Weak Artist",
      "Weak Track",
      new Date(AS_OF.getTime() - 90 * DAY_MS),
    ),
  ];
  for (let index = 0; index < 80; index += 1) {
    history.push(
      historicalEvent(
        "strong",
        "Strong Artist",
        "Strong Track",
        new Date(AS_OF.getTime() - (40 + index) * DAY_MS),
      ),
    );
  }

  const preview = buildCompleteDiscoveryPlannerPreview({
    profile: completeProfile(history),
    sourceUniverse,
    trackIdentities: [],
    targets: [TARGET],
  });

  assert.equal(sourceUniverse.evidence.readCalls, 2);
  assert.equal(sourceUniverse.evidence.sources[0]?.done, true);
  assert.equal(preview.scoring.selectionPolicy.candidateUniverse, "COMPLETE");
  assert.equal(preview.scoring.selectionPolicy.selectionReady, true);
  assert.equal(preview.plan.targets[0]?.result.items[0]?.spotifyTrackId, "strong");
});

test("Gate 3B dedupes MUSIC URIs only after every source cursor completes", async () => {
  const repeated = music("same", "Artist", "Track");
  const universe = await collectCompleteDiscoverySourceUniverse([
    sourceWithPages("source-a", "MUSIC", [[repeated]]),
    sourceWithPages("source-b", "MUSIC", [[repeated]]),
  ]);

  assert.equal(universe.music.length, 1);
  assert.equal(universe.evidence.duplicateMusicUriDroppedCount, 1);
  assert.equal(universe.evidence.sources.every((source) => source.done), true);
});

test("Gate 3B recovery discards partial candidates from a degraded source", async () => {
  const partial = music("partial", "Partial Artist", "Partial Track");
  const healthy = music("healthy", "Healthy Artist", "Healthy Track");
  let calls = 0;
  const degraded: DiscoveryPreviewSource = {
    id: "degraded",
    label: "degraded",
    kind: "MUSIC",
    get done() {
      return false;
    },
    async readNext() {
      calls += 1;
      if (calls === 1) return { candidates: [partial], done: false };
      throw new Error("HTTP 502");
    },
  };

  const universe = await collectCompleteDiscoverySourceUniverse(
    [degraded, sourceWithPages("healthy", "MUSIC", [[healthy]])],
    { recoverSourceFailure: (_source, error) => String(error).includes("502") },
  );

  assert.deepEqual(universe.music.map((candidate) => candidate.spotifyTrackId), ["healthy"]);
  assert.equal(universe.degradedFailures.length, 1);
  assert.equal(universe.degradedFailures[0]?.source.id, "degraded");
  assert.equal(universe.evidence.degradedSourceCount, 1);
  assert.deepEqual(universe.evidence.sources.map((source) => source.id), ["healthy"]);
});

test("Gate 3B keeps non-recoverable source failures fail-closed", async () => {
  const broken: DiscoveryPreviewSource = {
    id: "non-recoverable",
    label: "non-recoverable",
    kind: "MUSIC",
    get done() {
      return false;
    },
    async readNext() {
      throw new Error("HTTP 503");
    },
  };

  await assert.rejects(
    collectCompleteDiscoverySourceUniverse([broken], {
      recoverSourceFailure: () => false,
    }),
    /503/,
  );
});

test("Gate 3B refuses a cursor that claims a finished batch without actually closing", async () => {
  const broken: DiscoveryPreviewSource = {
    id: "broken",
    label: "broken",
    kind: "MUSIC",
    get done() {
      return false;
    },
    async readNext() {
      return { candidates: [], done: true };
    },
  };

  await assert.rejects(
    collectCompleteDiscoverySourceUniverse([broken]),
    /reported batch\.done=true while its cursor remained open/,
  );
});