import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/services/playlist-planner";

import {
  generationRunPlanRolesAreSafeForBehavioralEvidence,
} from "./playback-reserve-gate6";
import {
  preparePlaybackReserveGate8KeepFilledInput,
  type PlaybackReserveGate8KeepFilledContext,
} from "./playback-reserve-gate8";
import { savePlaybackReservePolicy } from "./playback-reserve-policy";
import {
  playbackReserveKeepFilledNeedsInlineSimulation,
  playbackReserveShadowRuntimeSummary,
  preparePlaybackReserveShadowRuntime,
} from "./playback-reserve-shadow-runtime";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;
const MINUTE = 60_000;

function music(id: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    albumId: `album-${id}`,
    durationMs: 4 * MINUTE,
  };
}

test("Gate 8 behavioral fail-closed also covers ACTIVE Gate 8 summaries", () => {
  assert.equal(
    generationRunPlanRolesAreSafeForBehavioralEvidence({
      playbackReserveRuntime: {
        gate: 8,
        effectiveMode: "ACTIVE",
        rolePersistenceStatus: "FAILED",
      },
    }),
    false,
  );
  assert.equal(
    generationRunPlanRolesAreSafeForBehavioralEvidence({
      playbackReserveRuntime: {
        gate: 8,
        effectiveMode: "ACTIVE",
        rolePersistenceStatus: "PERSISTED",
      },
    }),
    true,
  );
});

databaseTest("Gate 8 removes previous RESERVE from KEEP_FILLED PRIMARY preservation", async () => {
  const suffix = randomUUID();
  const userId = `reserve-gate8-split-user-${suffix}`;
  const targetId = `reserve-gate8-split-target-${suffix}`;
  const runId = `reserve-gate8-split-run-${suffix}`;
  const primary = music("primary");
  const reserve = music("reserve");

  await prisma.user.create({ data: { id: userId } });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "Gate 8 split",
      fixedDurationSeconds: 3600,
      sequencePattern: ["MUSIC"],
      updatePolicy: "KEEP_FILLED",
    },
  });
  await prisma.generationRun.create({
    data: {
      id: runId,
      userId,
      trigger: "SCHEDULED",
      simulation: false,
      status: "SUCCESS",
      summary: {
        playbackReserveRuntime: {
          gate: 7,
          effectiveMode: "ACTIVE",
          rolePersistenceStatus: "PERSISTED",
        },
      },
    },
  });
  await prisma.generationItem.createMany({
    data: [primary, reserve].map((item, position) => ({
      runId,
      targetPlaylistId: targetId,
      position,
      contentType: item.type,
      spotifyUri: item.uri,
      title: item.title,
      durationMs: item.durationMs,
      spotifyTrackId: item.spotifyTrackId,
    })),
  });
  await prisma.generationPlanItemRole.create({
    data: {
      runId,
      targetPlaylistId: targetId,
      position: 1,
      role: "RESERVE",
      reservePolicy: {
        targetPlaylistId: targetId,
        source: "GLOBAL",
        reserveMode: "MUSIC_TRACKS",
        durationSeconds: null,
        musicTrackCount: 1,
        podcastEpisodeCount: null,
        podcastInDurationReserve: "DISABLED",
      },
    },
  });

  const baseInput = {
    userId,
    targetPlaylistIds: [targetId],
    preservedByTargetId: { [targetId]: [primary, reserve] },
    keepFilledByTargetId: {
      [targetId]: {
        snapshotBefore: "snapshot-a",
        preservedUris: [primary.uri, reserve.uri],
        removeUris: [],
        forceReplace: false,
        targetDurationMs: 8 * MINUTE,
        validDurationBeforeMs: 8 * MINUTE,
        removedDurationMs: 0,
        preservedCount: 2,
        removedCount: 0,
        unknownReplayPolicyCount: 0,
      },
    },
    scheduledPolicyByTargetId: { [targetId]: "KEEP_FILLED" as const },
  };

  try {
    const prepared = await preparePlaybackReserveGate8KeepFilledInput(baseInput);
    assert.deepEqual(
      prepared.preservedByTargetId[targetId]?.map((item) => item.uri),
      [primary.uri],
    );
    assert.deepEqual(prepared.keepFilledByTargetId[targetId]?.preservedUris, [
      primary.uri,
    ]);
    assert.deepEqual(prepared.keepFilledByTargetId[targetId]?.removeUris, [
      reserve.uri,
    ]);
    assert.equal(
      prepared.keepFilledByTargetId[targetId]?.validDurationBeforeMs,
      4 * MINUTE,
    );
    assert.equal(
      prepared.keepFilledByTargetId[targetId]?.removedDurationMs,
      4 * MINUTE,
    );
    assert.equal(prepared.keepFilledByTargetId[targetId]?.preservedCount, 1);
    assert.equal(prepared.keepFilledByTargetId[targetId]?.removedCount, 1);
    assert.deepEqual(prepared.contextByTargetId[targetId], {
      snapshotBefore: "snapshot-a",
      previousRunId: runId,
      previousReserveCount: 1,
      previousReserveDurationMs: 4 * MINUTE,
    });

    await prisma.generationRun.update({
      where: { id: runId },
      data: {
        summary: {
          playbackReserveRuntime: {
            gate: 8,
            effectiveMode: "ACTIVE",
            rolePersistenceStatus: "FAILED",
          },
        },
      },
    });
    await assert.rejects(
      () => preparePlaybackReserveGate8KeepFilledInput(baseInput),
      /no trustworthy PRIMARY\/RESERVE sidecar/,
    );

    await prisma.generationRun.update({
      where: { id: runId },
      data: { summary: {} },
    });
    await prisma.generationPlanItemRole.deleteMany({ where: { runId } });
    const historical = await preparePlaybackReserveGate8KeepFilledInput(baseInput);
    assert.deepEqual(
      historical.preservedByTargetId[targetId]?.map((item) => item.uri),
      [primary.uri, reserve.uri],
    );
  } finally {
    await prisma.generationPlanItemRole.deleteMany({ where: { runId } }).catch(() => undefined);
    await prisma.generationRun.delete({ where: { id: runId } }).catch(() => undefined);
    await prisma.targetPlaylist.delete({ where: { id: targetId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

databaseTest("Gate 8 KEEP_FILLED ACTIVE approval is bound to the exact playlist snapshot", async () => {
  const suffix = randomUUID();
  const userId = `reserve-gate8-runtime-user-${suffix}`;
  const targetId = `reserve-gate8-runtime-target-${suffix}`;
  const oldMode = process.env.PLAYBACK_RESERVE_RUNTIME_MODE;
  const oldTargets = process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS;
  const contextA: PlaybackReserveGate8KeepFilledContext = {
    snapshotBefore: "snapshot-a",
    previousRunId: null,
    previousReserveCount: 0,
    previousReserveDurationMs: 0,
  };
  const contextB: PlaybackReserveGate8KeepFilledContext = {
    ...contextA,
    snapshotBefore: "snapshot-b",
  };

  await prisma.user.create({ data: { id: userId } });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "Gate 8 runtime",
      fixedDurationSeconds: 3600,
      sequencePattern: ["MUSIC"],
      updatePolicy: "KEEP_FILLED",
    },
  });
  await savePlaybackReservePolicy(userId, {
    reserveMode: "MUSIC_TRACKS",
    musicTrackCount: 2,
  });

  try {
    process.env.PLAYBACK_RESERVE_RUNTIME_MODE = "ACTIVE";
    process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS = targetId;

    const withoutContext = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(withoutContext.effectiveMode, "SHADOW");
    assert.equal(withoutContext.status, "ABSTAIN_KEEP_FILLED_CONTEXT_REQUIRED");

    const simulation = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
      scheduledPolicyByTargetId: { [targetId]: "KEEP_FILLED" },
      keepFilledContextByTargetId: { [targetId]: contextA },
    });
    assert.equal(simulation.gate, 8);
    assert.equal(simulation.effectiveMode, "ACTIVE");
    assert.equal(simulation.maintenanceMode, "KEEP_FILLED");
    assert.equal(simulation.keepFilledSnapshotBefore, "snapshot-a");
    assert.equal(simulation.status, "READY_ACTIVE_SIMULATION");

    const beforeApproval = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
      scheduledPolicyByTargetId: { [targetId]: "KEEP_FILLED" },
      keepFilledContextByTargetId: { [targetId]: contextA },
    });
    assert.equal(beforeApproval.effectiveMode, "SHADOW");
    assert.equal(beforeApproval.status, "ABSTAIN_SIMULATION_REQUIRED");
    assert.equal(playbackReserveKeepFilledNeedsInlineSimulation(beforeApproval), true);

    simulation.rolePersistenceStatus = "PERSISTED";
    simulation.reserveRoleCount = 2;
    const approval = await prisma.generationRun.create({
      data: {
        userId,
        trigger: "SIMULATION",
        simulation: true,
        status: "SUCCESS",
        summary: {
          playbackReserveRuntime: playbackReserveShadowRuntimeSummary(simulation),
        },
      },
    });

    const approved = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
      scheduledPolicyByTargetId: { [targetId]: "KEEP_FILLED" },
      keepFilledContextByTargetId: { [targetId]: contextA },
    });
    assert.equal(approved.effectiveMode, "ACTIVE");
    assert.equal(approved.status, "READY_ACTIVE_REAL");
    assert.equal(approved.simulationApprovedRunId, approval.id);

    const changedSnapshot = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
      scheduledPolicyByTargetId: { [targetId]: "KEEP_FILLED" },
      keepFilledContextByTargetId: { [targetId]: contextB },
    });
    assert.equal(changedSnapshot.effectiveMode, "SHADOW");
    assert.equal(changedSnapshot.status, "ABSTAIN_SIMULATION_REQUIRED");
    assert.notEqual(
      changedSnapshot.simulationApprovalKey,
      simulation.simulationApprovalKey,
    );
  } finally {
    if (oldMode === undefined) delete process.env.PLAYBACK_RESERVE_RUNTIME_MODE;
    else process.env.PLAYBACK_RESERVE_RUNTIME_MODE = oldMode;
    if (oldTargets === undefined) delete process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS;
    else process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS = oldTargets;

    await prisma.generationRun.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaybackReservePolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.playbackReservePolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaylist.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});
