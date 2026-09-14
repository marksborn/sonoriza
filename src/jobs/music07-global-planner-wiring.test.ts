import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, RunTarget } from "@/services/playlist-planner";

import {
  collectIncrementally,
  mergeBlockedMusicTrackIdsByTargetId,
  type IncrementalCandidateSource,
} from "./incremental-planning";
import { offMusic07EligibilityRuntimeState } from "./music-exposure-runtime";
import { runWithMusicRepeatState } from "./music-repeat-runtime";

test("MUSIC-07 blocks are unioned with MUSIC-05 only within the same target", () => {
  const music05 = new Map<string, ReadonlySet<string>>([
    ["carro", new Set(["m05-carro", "shared"])],
    ["trabalho", new Set(["m05-trabalho"])],
  ]);
  const music07 = new Map<string, ReadonlySet<string>>([
    ["carro", new Set(["m07-carro", "shared"])],
    ["avulsa", new Set(["m07-avulsa"])],
  ]);

  const merged = mergeBlockedMusicTrackIdsByTargetId(music05, music07);

  assert.deepEqual([...merged.get("carro")!].sort(), [
    "m05-carro",
    "m07-carro",
    "shared",
  ]);
  assert.deepEqual([...merged.get("trabalho")!], ["m05-trabalho"]);
  assert.deepEqual([...merged.get("avulsa")!], ["m07-avulsa"]);
});

test("same track blocked on one target does not contaminate another target", () => {
  const music07 = new Map<string, ReadonlySet<string>>([
    ["carro", new Set(["track-x"])],
    ["avulsa", new Set(["track-y"])],
  ]);

  const merged = mergeBlockedMusicTrackIdsByTargetId(undefined, music07);

  assert.equal(merged.get("carro")?.has("track-x"), true);
  assert.equal(merged.get("carro")?.has("track-y"), false);
  assert.equal(merged.get("avulsa")?.has("track-y"), true);
  assert.equal(merged.get("avulsa")?.has("track-x"), false);
});

test("empty maps remain empty and input sets are not mutated", () => {
  const baseSet = new Set(["a"]);
  const music07Set = new Set(["b"]);
  const base = new Map<string, ReadonlySet<string>>([["carro", baseSet]]);
  const music07 = new Map<string, ReadonlySet<string>>([["carro", music07Set]]);

  const merged = mergeBlockedMusicTrackIdsByTargetId(base, music07);
  (merged.get("carro") as Set<string>).add("c");

  assert.deepEqual([...baseSet], ["a"]);
  assert.deepEqual([...music07Set], ["b"]);
  assert.equal(mergeBlockedMusicTrackIdsByTargetId(undefined, undefined).size, 0);
});

test("collectIncrementally applies MUSIC-07 blocks through the target-aware planner seam", async () => {
  const music07 = offMusic07EligibilityRuntimeState();
  music07.configuredMode = "ACTIVE";
  music07.effectiveMode = "ACTIVE";
  music07.productiveInfluenceAllowed = true;
  music07.status = "READY_ACTIVE";
  // Deliberately leave the legacy shared blocked set empty. If this test passes,
  // the exclusion came from blockedTrackIdsByTargetId inside the planner.
  music07.blockedTrackIds = new Set<string>();
  music07.blockedTrackIdsByTargetId = new Map([
    ["carro", new Set(["A"])],
    ["avulsa", new Set(["B"])],
  ]);

  const source = fakeMusicSource([
    musicCandidate("A"),
    musicCandidate("B"),
    musicCandidate("C"),
  ]);

  const result = await runWithMusicRepeatState(
    {
      userId: "user-1",
      simulate: true,
      context: {
        enabled: false,
        windowValue: null,
        windowUnit: null,
        cutoff: null,
        historyKnownSince: null,
        lastSyncAt: null,
        blockedTrackIds: new Set<string>(),
      },
      initialSync: {
        enabled: false,
        eventsRead: 0,
        identitiesUpdated: 0,
        listeningEventsInserted: 0,
        listeningEventsDuplicateCount: 0,
        listeningEventsSuppressedByHandoff: 0,
        historyKnownSince: null,
        lastSyncAt: null,
      },
      repeatCompliance: {
        allowed: false,
        lineage: "TEST",
        uses: [],
        decisions: [],
      } as never,
      recentlyPlayedSkippedCount: 0,
      missingTrackIdentitySkippedCount: 0,
      preWriteSync: null,
      preWriteRevalidated: false,
      preWriteBlockedCount: 0,
      preWriteMissingIdentityCount: 0,
      music07Eligibility: music07,
      firstPartyPlaybackPreferences: [],
      firstPartyPreferenceEvidence: null,
      likedTrackSourceShadow: null,
    },
    () =>
      collectIncrementally({
        sources: [source],
        targets: [musicTarget("carro", 0), musicTarget("avulsa", 1)],
        revalidateBeforeWrite: async () => undefined,
      }),
  );

  const carro = result.plan.targets.find((target) => target.targetPlaylistId === "carro");
  const avulsa = result.plan.targets.find((target) => target.targetPlaylistId === "avulsa");

  assert.ok(carro);
  assert.ok(avulsa);
  assert.equal(carro.result.items.some((item) => item.spotifyTrackId === "A"), false);
  assert.equal(avulsa.result.items.some((item) => item.spotifyTrackId === "B"), false);
  assert.equal(avulsa.result.items.some((item) => item.spotifyTrackId === "A"), true);
});

function musicCandidate(spotifyTrackId: string): Candidate {
  return {
    type: "MUSIC",
    uri: `spotify:track:${spotifyTrackId}`,
    title: spotifyTrackId,
    durationMs: 180_000,
    spotifyTrackId,
  };
}

function musicTarget(targetPlaylistId: string, priority: number): RunTarget {
  return {
    targetPlaylistId,
    name: targetPlaylistId,
    priority,
    rules: {
      targetDurationMs: 180_000,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 1,
    },
  };
}

function fakeMusicSource(candidates: Candidate[]): IncrementalCandidateSource {
  let done = false;
  return {
    id: "music-source",
    label: "music-source",
    kind: "MUSIC",
    get done() {
      return done;
    },
    async readNext() {
      done = true;
      return { candidates, done: true };
    },
  };
}
