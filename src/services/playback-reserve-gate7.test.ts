import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import type { PlaybackReserveTargetShadowEvidence } from "@/services/playlist-planner/plan-run-playback-reserve";

import {
  findReusablePlaybackReserveSimulationEvidence,
  playbackReserveGate7ProjectionFingerprint,
  playbackReserveGate7RuntimeFromEnvironment,
  playbackReserveGate7TargetIsActive,
  projectionFingerprintsFromSummary,
} from "./playback-reserve-gate7";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;

function targetEvidence(
  targetPlaylistId = "target-a",
  reserveUri = "spotify:track:reserve-a",
): PlaybackReserveTargetShadowEvidence {
  return {
    targetPlaylistId,
    targetName: "Carro",
    status: "READY_SHADOW",
    plannerInfluence: false,
    spotifyWriteInfluence: false,
    additionalProviderReads: false,
    candidateCoverage: "PRIMARY_COLLECTION_ONLY",
    policy: {
      targetPlaylistId,
      source: "GLOBAL",
      reserveMode: "MUSIC_TRACKS",
      durationSeconds: null,
      musicTrackCount: 1,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "DISABLED",
    },
    primary: {
      itemCount: 2,
      totalDurationMs: 360_000,
      deficitMs: 0,
      compositionQualityPassed: true,
      orderHash: "primary-order-hash",
      segmentationBlockCount: 0,
    },
    reserve: {
      mode: "MUSIC_TRACKS",
      startsAtPosition: 2,
      requestedCount: 1,
      plannedCount: 1,
      shortfallCount: 0,
      plannedDurationMs: 180_000,
      itemCount: 1,
      musicCount: 1,
      podcastCount: 0,
      fallbackApplied: false,
      selectedItems: [
        {
          position: 2,
          role: "RESERVE",
          uri: reserveUri,
          type: "MUSIC",
          title: "Reserve A",
          subtitle: "Artist A",
          durationMs: 180_000,
          spotifyTrackId: "reserve-a",
          spotifyEpisodeId: null,
          programId: null,
          primaryArtistId: "artist-a",
          albumId: "album-a",
          originalDurationMs: null,
          resumePositionMs: null,
          sourcePlaylistId: "source-a",
          sourceSpotifyType: "PLAYLIST",
          sourceSpotifyId: "playlist-a",
          sourceIncludePlayed: null,
        },
      ],
    },
  };
}

test("Gate 7 defaults to SHADOW and ACTIVE fails closed without target allowlist", () => {
  const shadow = playbackReserveGate7RuntimeFromEnvironment({});
  assert.equal(shadow.requestedMode, "SHADOW");
  assert.equal(shadow.effectiveMode, "SHADOW");
  assert.equal(shadow.status, "READY_SHADOW");

  const emptyActive = playbackReserveGate7RuntimeFromEnvironment({
    PLAYBACK_RESERVE_RUNTIME_MODE: "ACTIVE",
    PLAYBACK_RESERVE_ACTIVE_TARGET_IDS: "",
  });
  assert.equal(emptyActive.requestedMode, "ACTIVE");
  assert.equal(emptyActive.effectiveMode, "SHADOW");
  assert.equal(emptyActive.status, "ABSTAIN_ACTIVE_TARGET_ALLOWLIST_EMPTY");
  assert.equal(playbackReserveGate7TargetIsActive(emptyActive, "target-a"), false);

  const invalid = playbackReserveGate7RuntimeFromEnvironment({
    PLAYBACK_RESERVE_RUNTIME_MODE: "banana",
    PLAYBACK_RESERVE_ACTIVE_TARGET_IDS: "target-a",
  });
  assert.equal(invalid.effectiveMode, "OFF");
  assert.equal(invalid.status, "ABSTAIN_INVALID_MODE");
});

test("Gate 7 ACTIVE authorizes only exact target ids", () => {
  const runtime = playbackReserveGate7RuntimeFromEnvironment({
    PLAYBACK_RESERVE_RUNTIME_MODE: "ACTIVE",
    PLAYBACK_RESERVE_ACTIVE_TARGET_IDS: "target-a, target-b\ntarget-c",
  });
  assert.equal(runtime.effectiveMode, "ACTIVE");
  assert.equal(runtime.status, "READY_ACTIVE");
  assert.equal(playbackReserveGate7TargetIsActive(runtime, "target-a"), true);
  assert.equal(playbackReserveGate7TargetIsActive(runtime, "target-b"), true);
  assert.equal(playbackReserveGate7TargetIsActive(runtime, "target-c"), true);
  assert.equal(playbackReserveGate7TargetIsActive(runtime, "target-d"), false);
});

test("projection proof binds policy, PRIMARY identity and ordered RESERVE suffix", () => {
  const baseline = targetEvidence();
  const same = targetEvidence();
  const changedReserve = targetEvidence("target-a", "spotify:track:reserve-b");

  assert.equal(
    playbackReserveGate7ProjectionFingerprint(baseline),
    playbackReserveGate7ProjectionFingerprint(same),
  );
  assert.notEqual(
    playbackReserveGate7ProjectionFingerprint(baseline),
    playbackReserveGate7ProjectionFingerprint(changedReserve),
  );

  const fromSummary = projectionFingerprintsFromSummary({
    playbackReserveShadow: { targets: [baseline] },
  });
  assert.equal(
    fromSummary.get("target-a"),
    playbackReserveGate7ProjectionFingerprint(baseline),
  );
});

databaseTest(
  "Gate 7 reuses one current quality-approved simulation and consumes it after a real applied run",
  async () => {
    const suffix = randomUUID();
    const userId = `reserve-gate7-user-${suffix}`;
    const targetPlaylistId = `reserve-gate7-target-${suffix}`;
    const simulationRunId = `reserve-gate7-sim-${suffix}`;
    const realRunId = `reserve-gate7-real-${suffix}`;
    const fingerprint = `reserve-gate7-fingerprint-${suffix}`;
    const target = targetEvidence(targetPlaylistId);
    const projectionFingerprint = playbackReserveGate7ProjectionFingerprint(target);
    assert.ok(projectionFingerprint);

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "Gate 7 target",
        fixedDurationSeconds: 3600,
        sequencePattern: ["MUSIC"],
      },
    });
    await prisma.generationRun.create({
      data: {
        id: simulationRunId,
        userId,
        trigger: "SIMULATION",
        simulation: true,
        status: "SUCCESS",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 50_000),
        summary: {
          qualityPassed: true,
          configurationFingerprint: fingerprint,
          playbackReserveShadow: {
            gate: 5,
            mode: "SHADOW",
            status: "READY_SHADOW",
            targets: [target],
          },
        },
      },
    });

    try {
      const reusable = await findReusablePlaybackReserveSimulationEvidence(
        userId,
        fingerprint,
        [targetPlaylistId],
      );
      assert.equal(reusable.size, 1);
      assert.equal(reusable.get(targetPlaylistId)?.simulationRunId, simulationRunId);
      assert.equal(
        reusable.get(targetPlaylistId)?.projectionFingerprint,
        projectionFingerprint,
      );

      const wrongFingerprint = await findReusablePlaybackReserveSimulationEvidence(
        userId,
        `${fingerprint}-changed`,
        [targetPlaylistId],
      );
      assert.equal(wrongFingerprint.size, 0);

      await prisma.generationRun.create({
        data: {
          id: realRunId,
          userId,
          trigger: "MANUAL",
          simulation: false,
          status: "SUCCESS",
          startedAt: new Date(),
          finishedAt: new Date(),
          summary: { qualityPassed: true },
        },
      });

      const consumed = await findReusablePlaybackReserveSimulationEvidence(
        userId,
        fingerprint,
        [targetPlaylistId],
      );
      assert.equal(consumed.size, 0);
    } finally {
      await prisma.generationRun.deleteMany({ where: { userId } });
      await prisma.targetPlaylist.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);
