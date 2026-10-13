import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { savePlaybackReservePolicy } from "./playback-reserve-policy";
import {
  loadTargetReserveActivation,
  saveTargetReserveActivation,
} from "./playback-reserve-product-activation";
import {
  playbackReserveShadowRuntimeSummary,
  preparePlaybackReserveShadowRuntime,
} from "./playback-reserve-shadow-runtime";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;

databaseTest("B1.3: user opt-in and admin kill switch are both required; revoke always closes gate", async () => {
  const suffix = randomUUID();
  const userId = `reserve-b13-user-${suffix}`;
  const outsiderId = `reserve-b13-outside-${suffix}`;
  const targetId = `reserve-b13-target-${suffix}`;
  const old = {
    runtime: process.env.PLAYBACK_RESERVE_RUNTIME_MODE,
    allowlist: process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS,
    product: process.env.PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE,
    simulation: process.env.PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE,
  };

  await prisma.user.createMany({ data: [{ id: userId }, { id: outsiderId }] });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "B1.3 product opt-in",
      spotifyPlaylistId: `spotify-product-${suffix}`,
      enabled: true,
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
    process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS = "";
    process.env.PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE = "OFF";
    delete process.env.PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE;

    assert.equal((await loadTargetReserveActivation(userId, targetId)).enabled, false);
    await assert.rejects(
      () => saveTargetReserveActivation({ userId: outsiderId, targetPlaylistId: targetId, enabled: true }),
      /not found for account/,
    );

    const before = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(before.status, "ABSTAIN_TARGET_NOT_ALLOWED");

    const optedIn = await saveTargetReserveActivation({
      userId,
      targetPlaylistId: targetId,
      enabled: true,
    });
    assert.equal(optedIn.enabled, true);
    assert.ok(optedIn.confirmedAt instanceof Date);

    const rolloutOff = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(rolloutOff.status, "ABSTAIN_TARGET_NOT_ALLOWED");

    process.env.PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE = "ACTIVE";
    const simulation = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(simulation.authorizationSource, "PRODUCT_OPT_IN");
    assert.equal(simulation.status, "READY_ACTIVE_SIMULATION");
    assert.equal(simulation.spotifyWriteInfluence, false);

    const beforeApproval = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
    });
    assert.equal(beforeApproval.status, "ABSTAIN_SIMULATION_REQUIRED");
    assert.equal(beforeApproval.spotifyWriteInfluence, false);

    simulation.rolePersistenceStatus = "PERSISTED";
    simulation.reserveRoleCount = 2;
    const approval = await prisma.generationRun.create({
      data: {
        userId,
        trigger: "SIMULATION",
        simulation: true,
        status: "SUCCESS",
        summary: { playbackReserveRuntime: playbackReserveShadowRuntimeSummary(simulation) },
      },
    });

    const real = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
    });
    assert.equal(real.status, "READY_ACTIVE_REAL");
    assert.equal(real.authorizationSource, "PRODUCT_OPT_IN");
    assert.equal(real.simulationApprovedRunId, approval.id);

    await prisma.targetPlaylist.update({
      where: { id: targetId },
      data: { spotifyPlaylistId: `spotify-other-${suffix}` },
    });
    const movedDestination = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
    });
    assert.equal(movedDestination.status, "ABSTAIN_SIMULATION_REQUIRED");
    assert.notEqual(movedDestination.simulationApprovalKey, real.simulationApprovalKey);

    await saveTargetReserveActivation({
      userId,
      targetPlaylistId: targetId,
      enabled: false,
    });
    const revoked = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
    });
    assert.equal(revoked.status, "ABSTAIN_TARGET_NOT_ALLOWED");
    assert.equal(revoked.spotifyWriteInfluence, false);
    assert.equal((await loadTargetReserveActivation(userId, targetId)).confirmedAt, null);
  } finally {
    for (const [key, value] of [
      ["PLAYBACK_RESERVE_RUNTIME_MODE", old.runtime],
      ["PLAYBACK_RESERVE_ACTIVE_TARGET_IDS", old.allowlist],
      ["PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE", old.product],
      ["PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE", old.simulation],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.generationRun.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaybackReserveActivation.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.playbackReservePolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaylist.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [userId, outsiderId] } } }).catch(() => undefined);
  }
});
