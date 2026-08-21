import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, RunTarget } from "@/services/playlist-planner";

import type { CompleteMusicDiscoveryProfile } from "./complete-profile";
import {
  buildGate3CHybridPlannerPreview,
  collectCompleteDiscoveryMusicUniverse,
  DISCOVERY_GATE3D_SEQUENCE_TERMINAL_UNDERFILL_TOLERANCE_MS,
} from "./planner-preview-gate3c";
import type { DiscoveryPreviewSource } from "./planner-preview";
import { buildMusicDiscoveryProfile } from "./profile";

const AS_OF = new Date("2026-08-21T01:54:44.214Z");

function music(id: string, durationMs: number): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    spotifyTrackId: id,
    primaryArtistId: `artist:${id}`,
    primaryArtistName: `Artist ${id}`,
    albumId: `album:${id}`,
    albumName: `Album ${id}`,
    title: `Track ${id}`,
    subtitle: `Artist ${id}`,
    durationMs,
  };
}

function podcast(id: string, durationMs: number): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: `Episode ${id}`,
    programId: `show:${id}`,
    durationMs,
  };
}

function source(
  id: string,
  kind: "MUSIC" | "PODCAST",
  batches: Array<{ candidates: Candidate[]; done: boolean }>,
): DiscoveryPreviewSource & { calls: number } {
  let index = 0;
  let done = batches.length === 0;
  return {
    id,
    label: id,
    kind,
    get done() {
      return done;
    },
    get calls() {
      return index;
    },
    async readNext() {
      const batch = batches[index];
      index += 1;
      if (!batch) throw new Error(`Unexpected read ${index} for ${id}`);
      done = batch.done;
      return batch;
    },
  };
}

function emptyCompleteProfile(): CompleteMusicDiscoveryProfile {
  const profile = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events: [],
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

function sequenceTarget(targetDurationMs: number): RunTarget {
  return {
    targetPlaylistId: "target-work",
    name: "Trabalho",
    priority: 1,
    rules: {
      targetDurationMs,
      compositionMode: "SEQUENCE",
      podcastPercent: 60,
      sequencePattern: ["MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 20,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

test("Gate 3D stops a 7h SEQUENCE at the real 10.933s terminal underfill without opening the other 12 podcast sources", async () => {
  const musicCandidates = [
    ...Array.from({ length: 10 }, (_, index) => music(`m${index + 1}`, 200_000)),
    music("m11", 323_429),
  ];
  const musicSource = source("music-complete", "MUSIC", [
    { candidates: musicCandidates, done: true },
  ]);

  const firstPodcastSource = source("podcast-primary", "PODCAST", [
    {
      candidates: [
        ...Array.from({ length: 9 }, (_, index) =>
          podcast(`p${index + 1}`, 2_000_000),
        ),
        podcast("p10", 4_865_638),
        podcast("p-too-long-for-tail", 60_000),
      ],
      done: true,
    },
  ]);
  const unopenedPodcastSources = Array.from({ length: 12 }, (_, index) =>
    source(`podcast-unopened-${index + 1}`, "PODCAST", [
      { candidates: [podcast(`tiny-${index + 1}`, 5_000)], done: true },
    ]),
  );

  const musicUniverse = await collectCompleteDiscoveryMusicUniverse([
    musicSource,
    firstPodcastSource,
    ...unopenedPodcastSources,
  ]);
  const preview = await buildGate3CHybridPlannerPreview({
    profile: emptyCompleteProfile(),
    musicUniverse,
    trackIdentities: [],
    targets: [sequenceTarget(25_200_000)],
    podcastSources: [firstPodcastSource, ...unopenedPodcastSources],
  });

  const planned = preview.incremental.plan.targets[0];
  assert.ok(planned);
  assert.equal(preview.version, "gate3d-preview-v1");
  assert.equal(
    preview.podcastEvidence.sequenceTerminalUnderfillToleranceMs,
    DISCOVERY_GATE3D_SEQUENCE_TERMINAL_UNDERFILL_TOLERANCE_MS,
  );
  assert.equal(planned.result.stats.totalDurationMs, 25_189_067);
  assert.equal(25_200_000 - planned.result.stats.totalDurationMs, 10_933);
  assert.equal(planned.result.stats.sequenceStopReason, "NO_FITTING_CANDIDATE");
  assert.equal(planned.result.stats.stoppedAtPatternIndex, 1);
  assert.equal(planned.result.stats.compositionQualityPassed, true);
  assert.equal(firstPodcastSource.calls, 1);
  assert.equal(preview.podcastEvidence.readSourceCount, 1);
  assert.equal(preview.podcastEvidence.readCalls, 1);
  assert.equal(preview.podcastEvidence.remainingSourceCount, 12);
  assert.equal(preview.podcastEvidence.stoppedEarly, true);
  assert.equal(
    unopenedPodcastSources.every((podcastSource) => podcastSource.calls === 0),
    true,
  );
});

test("Gate 3D keeps reading when a SEQUENCE underfill is larger than the 30s terminal tolerance", async () => {
  const musicSource = source("music-complete", "MUSIC", [
    {
      candidates: [music("m1", 400_000), music("m2", 400_000)],
      done: true,
    },
  ]);
  const firstPodcastSource = source("podcast-first", "PODCAST", [
    {
      candidates: [podcast("p1", 155_000), podcast("p-too-long", 60_000)],
      done: true,
    },
  ]);
  const secondPodcastSource = source("podcast-second", "PODCAST", [
    { candidates: [podcast("p2", 30_000)], done: true },
  ]);

  const musicUniverse = await collectCompleteDiscoveryMusicUniverse([
    musicSource,
    firstPodcastSource,
    secondPodcastSource,
  ]);
  const preview = await buildGate3CHybridPlannerPreview({
    profile: emptyCompleteProfile(),
    musicUniverse,
    trackIdentities: [],
    targets: [sequenceTarget(1_000_000)],
    podcastSources: [firstPodcastSource, secondPodcastSource],
  });

  assert.equal(firstPodcastSource.calls, 1);
  assert.equal(secondPodcastSource.calls, 1);
  assert.equal(preview.podcastEvidence.readSourceCount, 2);
});
