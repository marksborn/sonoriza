import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, RunTarget } from "@/services/playlist-planner";

import type { CompleteMusicDiscoveryProfile } from "./complete-profile";
import {
  buildGate3CHybridPlannerPreview,
  collectCompleteDiscoveryMusicUniverse,
} from "./planner-preview-gate3c";
import type { DiscoveryPreviewSource } from "./planner-preview";
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

function podcast(id: string): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    programId: `show:${id}`,
    durationMs: 180_000,
  };
}

function sourceWithPages(
  id: string,
  kind: "MUSIC" | "PODCAST",
  pages: Candidate[][],
): DiscoveryPreviewSource & { calls: number } {
  let index = 0;
  let done = pages.length === 0;
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
  name: "Hybrid",
  priority: 1,
  rules: {
    targetDurationMs: 360_000,
    compositionMode: "PROPORTION",
    podcastPercent: 50,
    sequencePattern: [],
    maxEpisodesPerProgram: 10,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
  },
};

test("Gate 3C exhausts MUSIC but leaves PODCAST cursors untouched during the complete-universe phase", async () => {
  const musicSource = sourceWithPages("music", "MUSIC", [
    [music("weak", "Weak", "Weak")],
    [music("strong", "Strong", "Strong")],
  ]);
  const podcastSource = sourceWithPages("podcast", "PODCAST", [
    [podcast("p1")],
    [podcast("p2")],
  ]);

  const result = await collectCompleteDiscoveryMusicUniverse([
    musicSource,
    podcastSource,
  ]);

  assert.equal(result.universe, "MUSIC_COMPLETE");
  assert.equal(result.sourceUniverse.music.length, 2);
  assert.equal(result.sourceUniverse.evidence.readCalls, 2);
  assert.equal(musicSource.done, true);
  assert.equal(musicSource.calls, 2);
  assert.equal(podcastSource.done, false);
  assert.equal(podcastSource.calls, 0);
  assert.equal(result.ignoredPodcastSourceCount, 1);
});

test("Gate 3C ranks the complete MUSIC universe then lets PODCAST stop after the first sufficient page", async () => {
  const weak = music("weak", "Weak Artist", "Weak Track");
  const strong = music("strong", "Strong Artist", "Strong Track");
  const musicSource = sourceWithPages("music", "MUSIC", [[weak], [strong]]);
  const podcastSource = sourceWithPages("podcast", "PODCAST", [
    [podcast("p1")],
    [podcast("p2")],
    [podcast("p3")],
  ]);
  const musicUniverse = await collectCompleteDiscoveryMusicUniverse([
    musicSource,
    podcastSource,
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

  const preview = await buildGate3CHybridPlannerPreview({
    profile: completeProfile(history),
    musicUniverse,
    trackIdentities: [],
    targets: [TARGET],
    podcastSources: [podcastSource],
  });

  assert.equal(preview.selection.scoring.selectionPolicy.candidateUniverse, "COMPLETE");
  assert.equal(preview.incremental.failure, null);
  assert.equal(preview.incremental.plan.targets[0]?.result.items[0]?.spotifyTrackId, "strong");
  assert.equal(podcastSource.calls, 1);
  assert.equal(podcastSource.done, false);
  assert.equal(preview.podcastEvidence.readCalls, 1);
  assert.equal(preview.podcastEvidence.stoppedEarly, true);
  assert.equal(preview.podcastEvidence.remainingSourceCount, 1);
});
