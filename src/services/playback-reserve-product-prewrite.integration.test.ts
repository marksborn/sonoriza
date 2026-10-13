import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { savePlaybackReservePolicy } from "./playback-reserve-policy";
import {
  saveTargetReserveActivation,
} from "./playback-reserve-product-activation";
import {
  assertPlaybackReserveProductAuthorizationBeforeWrite,
  playbackReserveShadowRuntimeSummary,
  preparePlaybackReserveShadowRuntime,
  runWithPlaybackReserveShadowRuntimeState,
} from "./playback-reserve-shadow-runtime";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;

databaseTest("B1.4: prewrite fence catches revoke, mode OFF, changed Spotify target, and edited policy", async () => {
  const suffix = randomUUID();
  const userId = `reserve-b14-user-${suffix}`;
  const targetId = `reserve-b14-target-${suffix}`;
  const spotifyPlaylistId = `b14-playlist-${suffix}`;
  const envKeys = [
    "PLAYBACK_RESERVE_RUNTIME_MODE",
    "PLAYBACK_RESERVE_ACTIVE_TARGET_IDS",
    "PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE",
    "PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE",
  ] as const;
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const context = { userId, targetPlaylistId: targetId };

  await prisma.user.create({ data: { id: userId } });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "B1.4 authorization fence",
      enabled: true,
      spotifyPlaylistId,
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
    process.env.PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE = "ACTIVE";
    process.env.PLAYBACK_RESERVE_CAPABILITY_SIMULATION_MODE = "OFF";

    await saveTargetReserveActivation({ userId, targetPlaylistId: targetId, enabled: true });
    const sim = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: true,
    });
    assert.equal(sim.authorizationSource, "PRODUCT_OPT_IN");
    assert.equal(sim.status, "READY_ACTIVE_SIMULATION");
    sim.rolePersistenceStatus = "PERSISTED";
    sim.reserveRoleCount = 2;
    await prisma.generationRun.create({
      data: {
        userId,
        trigger: "SIMULATION",
        simulation: true,
        status: "SUCCESS",
        summary: { playbackReserveRuntime: playbackReserveShadowRuntimeSummary(sim) },
      },
    });

    const state = await preparePlaybackReserveShadowRuntime({
      userId,
      targetPlaylistIds: [targetId],
      simulate: false,
    });
    assert.equal(state.status, "READY_ACTIVE_REAL");
    assert.equal(state.productPrewriteChecks, 0);

    const checked = () =>
      runWithPlaybackReserveShadowRuntimeState(
        state,
        () => assertPlaybackReserveProductAuthorizationBeforeWrite(context),
      );

    await checked();
    assert.equal(state.productPrewriteChecks, 1);

    process.env.PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE = "OFF";
    await assert.rejects(checked, /PRODUCT_PREWRITE_BLOCKED/);
    process.env.PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE = "ACTIVE";

    await saveTargetReserveActivation({ userId, targetPlaylistId: targetId, enabled: false });
    await assert.rejects(checked, /PRODUCT_PREWRITE_BLOCKED/);

    await saveTargetReserveActivation({ userId, targetPlaylistId: targetId, enabled: true });
    // Ensure the re-authorization revokes any previous simulation fingerprint,
    // even if the two writes occur within the same wall-clock millisecond.
    await prisma.targetPlaybackReserveActivation.update({
      where: { userId_targetPlaylistId: { userId, targetPlaylistId: targetId } },
      data: { confirmedAt: new Date(Date.now() + 60_000) },
    });
    await assert.rejects(checked, /PRODUCT_PREWRITE_BLOCKED/);

    // Re-establish the original approval binding solely inside this test DB.
    await prisma.targetPlaybackReserveActivation.update({
      where: { userId_targetPlaylistId: { userId, targetPlaylistId: targetId } },
      data: { confirmedAt: sim.productBinding?.confirmedAt ? new Date(sim.productBinding.confirmedAt) : null },
    });
    await checked();

    await prisma.targetPlaylist.update({
      where: { id: targetId },
      data: { spotifyPlaylistId: `relinked-${suffix}` },
    });
    await assert.rejects(checked, /PRODUCT_PREWRITE_BLOCKED/);
    await prisma.targetPlaylist.update({
      where: { id: targetId },
      data: { spotifyPlaylistId },
    });
    await checked();

    await savePlaybackReservePolicy(userId, {
      reserveMode: "MUSIC_TRACKS",
      musicTrackCount: 3,
    });
    await assert.rejects(checked, /PRODUCT_PREWRITE_BLOCKED/);

    await savePlaybackReservePolicy(userId, {
      reserveMode: "MUSIC_TRACKS",
      musicTrackCount: 2,
    });
    await checked();

    await prisma.targetPlaylist.update({
      where: { id: targetId },
      data: { updatePolicy: "MANUAL" },
    });
    await assert.rejects(checked, /PRODUCT_PREWRITE_BLOCKED/);

    assert.equal(state.productPrewriteChecks, 4);
  } finally {
    for (const key of envKeys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.generationRun.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaybackReserveActivation.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.playbackReservePolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.targetPlaylist.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

test("B1.4: legacy pilot and simulation-only contexts bypass new product-only checks", async () => {
  const base = {
    gate: 8 as const,
    configuredMode: "ACTIVE" as const,
    effectiveMode: "ACTIVE" as const,
    simulate: false,
    plannerInfluence: true,
    spotifyWriteInfluence: true,
    additionalProviderReads: false,
    policies: new Map(),
    evidence: null,
  };
  const checked = { userId: "nonexistent-user", targetPlaylistId: "nonexistent-target" };
  await assert.doesNotReject(
    () => runWithPlaybackReserveShadowRuntimeState(
      { ...base, authorizationSource: "LEGACY_TARGET_ALLOWLIST" },
      () => assertPlaybackReserveProductAuthorizationBeforeWrite(checked),
    ),
  );
  await assert.doesNotReject(
    () => runWithPlaybackReserveShadowRuntimeState(
      { ...base, simulate: true, spotifyWriteInfluence: false, authorizationSource: "CAPABILITY_SIMULATION" },
      () => assertPlaybackReserveProductAuthorizationBeforeWrite(checked),
    ),
  );
});
