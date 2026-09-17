import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  generationRunPlanRolesAreSafeForBehavioralEvidence,
} from "./playback-reserve-gate6";
import { savePlaybackReservePolicy } from "./playback-reserve-policy";
import {
  playbackReserveShadowRuntimeSummary,
  preparePlaybackReserveShadowRuntime,
} from "./playback-reserve-shadow-runtime";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;

test("Gate 7 behavioral evidence fails closed only for unsafe ACTIVE runtime", () => {
  assert.equal(generationRunPlanRolesAreSafeForBehavioralEvidence(null), true);
  assert.equal(
    generationRunPlanRolesAreSafeForBehavioralEvidence({
      playbackReserveRuntime: {
        gate: 7,
        effectiveMode: "SHADOW",
        rolePersistenceStatus: "NOT_APPLICABLE",
      },
    }),
    true,
  );
  assert.equal(
    generationRunPlanRolesAreSafeForBehavioralEvidence({
      playbackReserveRuntime: {
        gate: 7,
        effectiveMode: "ACTIVE",
        rolePersistenceStatus: "FAILED",
      },
    }),
    false,
  );
  assert.equal(
    generationRunPlanRolesAreSafeForBehavioralEvidence({
      playbackReserveRuntime: {
        gate: 7,
        effectiveMode: "ACTIVE",
        rolePersistenceStatus: "PERSISTED",
      },
    }),
    true,
  );
});

databaseTest("Gate 7 ACTIVE requires allowlisted single REBUILD_DAILY target and approved simulation", async () => {
  const suffix = randomUUID();
  const userId = `reserve-gate7-user-${suffix}`;
  const targetId = `reserve-gate7-target-${suffix}`;
  const oldMode = process.env.PLAYBACK_RESERVE_RUNTIME_MODE;
  const oldTargets = process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS;

  await prisma.user.create({ data: { id: userId } });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "Gate 7 target",
      fixedDurationSeconds: 3600,
      sequencePattern: ["MUSIC"],
      updatePolicy: "REBUILD_DAILY",
    },
  });
  await savePlaybackReservePolicy(userId, {
    reserveMode: "MUSIC_TRACKS",
    musicTrackCount: 2,
  });

  try {
    process.env.PLAYBACK_RESERVE_RUNTIME_MODE = "ACTIVE";
    process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS = targetId;

    const simulation = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(simulation.effectiveMode, "ACTIVE");
    assert.equal(simulation.status, "READY_ACTIVE_SIMULATION");
    assert.equal(simulation.plannerInfluence, true);
    assert.equal(simulation.spotifyWriteInfluence, false);
    assert.equal(simulation.rolePersistenceStatus, "PENDING");

    const beforeApproval = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
    });
    assert.equal(beforeApproval.effectiveMode, "SHADOW");
    assert.equal(beforeApproval.status, "ABSTAIN_SIMULATION_REQUIRED");
    assert.equal(beforeApproval.spotifyWriteInfluence, false);

    simulation.rolePersistenceStatus = "PERSISTED";
    simulation.reserveRoleCount = 2;
    await prisma.generationRun.create({
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
    });
    assert.equal(approved.effectiveMode, "ACTIVE");
    assert.equal(approved.status, "READY_ACTIVE_REAL");
    assert.equal(approved.spotifyWriteInfluence, true);
    assert.ok(approved.simulationApprovedRunId);

    await prisma.targetPlaylist.update({
      where: { id: targetId },
      data: { updatePolicy: "KEEP_FILLED" },
    });
    const keepFilled = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(keepFilled.effectiveMode, "SHADOW");
    assert.equal(keepFilled.status, "ABSTAIN_REBUILD_DAILY_REQUIRED");
  } finally {
    if (oldMode === undefined) delete process.env.PLAYBACK_RESERVE_RUNTIME_MODE;
    else process.env.PLAYBACK_RESERVE_RUNTIME_MODE = oldMode;
    if (oldTargets === undefined) delete process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS;
    else process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS = oldTargets;

    await prisma.generationPlanItemRole.deleteMany({ where: { runId: { startsWith: "reserve-gate7" } } }).catch(() => undefined);
    await prisma.generationRun.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaybackReservePolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.playbackReservePolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaylist.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});
