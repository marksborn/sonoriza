import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { savePlaybackReservePolicy } from "./playback-reserve-policy";
import { preparePlaybackReserveShadowRuntime } from "./playback-reserve-shadow-runtime";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;

databaseTest("B1.2/#470: capability simulation previews RESERVE in SHADOW and never authorizes a real run", async () => {
  const suffix = randomUUID();
  const userId = `reserve-b12-user-${suffix}`;
  const targetId = `reserve-b12-target-${suffix}`;
  const prior = {
    runtime: process.env.PLAYBACK_RESERVE_RUNTIME_MODE,
    allowlist: process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS,
    capability: process.env.PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE,
  };

  await prisma.user.create({ data: { id: userId } });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "B1.2 read-only simulation test",
      enabled: true,
      spotifyPlaylistId: `spotify-playlist-test-${suffix}`,
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
    process.env.PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE = "ACTIVE";

    const preview = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    // #470: capability-only simulation previews RESERVE without changing the
    // plan, so the simulated order is exactly what a real run can publish.
    assert.equal(preview.effectiveMode, "SHADOW");
    assert.equal(preview.status, "READY_PREVIEW_SIMULATION");
    assert.equal(preview.authorizationSource, "CAPABILITY_SIMULATION");
    assert.equal(preview.plannerInfluence, false);
    assert.equal(preview.spotifyWriteInfluence, false);
    assert.equal(preview.rolePersistenceStatus, "NOT_APPLICABLE");

    const real = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
    });
    assert.equal(real.effectiveMode, "SHADOW");
    assert.equal(real.status, "ABSTAIN_TARGET_NOT_ALLOWED");
    assert.equal(real.spotifyWriteInfluence, false);
    assert.equal(real.plannerInfluence, preview.plannerInfluence);

    // Without an explicit target, this feature does not grant capability simulation.
    const implicit = await preparePlaybackReserveShadowRuntime({
      userId,
      simulate: true,
    });
    assert.equal(implicit.status, "ABSTAIN_TARGET_NOT_ALLOWED");

    // The old pilot approval stays independent from the capability simulation.
    process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS = targetId;
    const allowedRealWithoutApprovedSimulation = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
    });
    assert.equal(allowedRealWithoutApprovedSimulation.effectiveMode, "SHADOW");
    assert.equal(allowedRealWithoutApprovedSimulation.status, "ABSTAIN_SIMULATION_REQUIRED");

    process.env.PLAYBACK_RESERVE_ACTIVE_TARGET_IDS = "";
    await prisma.targetPlaylist.update({
      where: { id: targetId },
      data: { updatePolicy: "KEEP_FILLED" },
    });
    const keepFilledWithoutScheduledContext = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(keepFilledWithoutScheduledContext.status, "ABSTAIN_KEEP_FILLED_CONTEXT_REQUIRED");

    process.env.PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE = "OFF";
    const featureOff = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(featureOff.status, "ABSTAIN_TARGET_NOT_ALLOWED");
  } finally {
    for (const [key, previous] of [
      ["PLAYBACK_RESERVE_RUNTIME_MODE", prior.runtime],
      ["PLAYBACK_RESERVE_ACTIVE_TARGET_IDS", prior.allowlist],
      ["PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE", prior.capability],
    ] as const) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    await prisma.targetPlaybackReservePolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.playbackReservePolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaylist.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});
