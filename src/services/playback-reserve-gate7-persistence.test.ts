import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";
import {
  runWithPlaybackReserveShadowRuntimeState,
  type PlaybackReserveShadowRuntimeState,
} from "@/services/playback-reserve-shadow-runtime";
import { planRun } from "@/services/playlist-planner/plan-run-playback-reserve";
import type { Candidate, PlaylistRules } from "@/services/playlist-planner/types";

import { persistPlaybackReserveRolesAfterGeneration } from "./playback-reserve-gate7";

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

function rules(): PlaylistRules {
  return {
    targetDurationMs: 4 * MINUTE,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: [],
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
  };
}

function policy(
  targetId: string,
  musicTrackCount = 1,
): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId: targetId,
    source: "GLOBAL",
    reserveMode: "MUSIC_TRACKS",
    durationSeconds: null,
    musicTrackCount,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  };
}

function activeState(
  targetId: string,
  reservePolicy: EffectivePlaybackReservePolicySnapshot,
): PlaybackReserveShadowRuntimeState {
  return {
    gate: 7,
    configuredMode: "ACTIVE",
    effectiveMode: "ACTIVE",
    simulate: true,
    plannerInfluence: true,
    spotifyWriteInfluence: false,
    additionalProviderReads: false,
    status: "READY_ACTIVE_SIMULATION",
    targetPlaylistIds: [targetId],
    allowedTargetIds: new Set([targetId]),
    policies: new Map([[targetId, reservePolicy]]),
    simulationApprovalKey: "persist-test",
    simulationApprovedRunId: null,
    rolePersistenceStatus: "PENDING",
    reserveRoleCount: 0,
    evidence: null,
  };
}

async function createFixture(input: {
  musicTrackCount: number;
  musicIds: string[];
}) {
  const suffix = randomUUID();
  const userId = `reserve-gate7-persist-user-${suffix}`;
  const targetId = `reserve-gate7-persist-target-${suffix}`;
  const runId = `reserve-gate7-persist-run-${suffix}`;
  const reservePolicy = policy(targetId, input.musicTrackCount);
  const state = activeState(targetId, reservePolicy);

  const plan = runWithPlaybackReserveShadowRuntimeState(state, () =>
    planRun({
      pools: { music: input.musicIds.map(music), podcasts: [] },
      targets: [
        { targetPlaylistId: targetId, name: "Gate 7", priority: 1, rules: rules() },
      ],
    }),
  );

  await prisma.user.create({ data: { id: userId } });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "Gate 7 persistence",
      fixedDurationSeconds: 240,
      sequencePattern: ["MUSIC"],
      updatePolicy: "REBUILD_DAILY",
    },
  });
  await prisma.generationRun.create({
    data: {
      id: runId,
      userId,
      trigger: "SIMULATION",
      simulation: true,
      status: "SUCCESS",
    },
  });

  return { userId, targetId, runId, reservePolicy, state, plan };
}

async function cleanupFixture(input: {
  userId: string;
  targetId: string;
  runId: string;
}) {
  await prisma.generationPlanItemRole.deleteMany({ where: { runId: input.runId } });
  await prisma.generationRun.delete({ where: { id: input.runId } }).catch(() => undefined);
  await prisma.targetPlaylist.delete({ where: { id: input.targetId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: input.userId } }).catch(() => undefined);
}

databaseTest("Gate 7 persists explicit RESERVE role against the physical GenerationItem coordinate", async () => {
  const fixture = await createFixture({
    musicTrackCount: 1,
    musicIds: ["primary", "reserve"],
  });

  await prisma.generationItem.createMany({
    data: fixture.plan.targets[0]!.result.items.map((item) => ({
      runId: fixture.runId,
      targetPlaylistId: fixture.targetId,
      position: item.position,
      contentType: item.type,
      spotifyUri: item.uri,
      title: item.title,
      durationMs: item.durationMs,
      spotifyTrackId: item.spotifyTrackId,
    })),
  });

  try {
    const count = await persistPlaybackReserveRolesAfterGeneration({
      runId: fixture.runId,
      state: fixture.state,
    });
    assert.equal(count, 1);

    const rows = await prisma.generationPlanItemRole.findMany({
      where: { runId: fixture.runId },
      orderBy: { position: "asc" },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, "RESERVE");
    assert.equal(rows[0]?.position, 1);
    assert.deepEqual(rows[0]?.reservePolicy, fixture.reservePolicy);
  } finally {
    await cleanupFixture(fixture);
  }
});

databaseTest("Gate 7 persists the final physical RESERVE suffix after music reorder", async () => {
  const fixture = await createFixture({
    musicTrackCount: 2,
    musicIds: ["primary", "reserve-a", "reserve-b"],
  });
  const plannedItems = fixture.plan.targets[0]!.result.items;
  assert.deepEqual(
    plannedItems.map((item) => item.uri),
    [
      "spotify:track:primary",
      "spotify:track:reserve-a",
      "spotify:track:reserve-b",
    ],
  );

  const physicalItems = [
    plannedItems[0]!,
    { ...plannedItems[2]!, position: 1 },
    { ...plannedItems[1]!, position: 2 },
  ];
  await prisma.generationItem.createMany({
    data: physicalItems.map((item) => ({
      runId: fixture.runId,
      targetPlaylistId: fixture.targetId,
      position: item.position,
      contentType: item.type,
      spotifyUri: item.uri,
      title: item.title,
      durationMs: item.durationMs,
      spotifyTrackId: item.spotifyTrackId,
    })),
  });

  try {
    const count = await persistPlaybackReserveRolesAfterGeneration({
      runId: fixture.runId,
      state: fixture.state,
    });
    assert.equal(count, 2);

    const rows = await prisma.generationPlanItemRole.findMany({
      where: { runId: fixture.runId },
      orderBy: { position: "asc" },
      select: { position: true, role: true },
    });
    assert.deepEqual(rows, [
      { position: 1, role: "RESERVE" },
      { position: 2, role: "RESERVE" },
    ]);
  } finally {
    await cleanupFixture(fixture);
  }
});

databaseTest("Gate 7 still fails closed when a RESERVE URI crosses the physical boundary", async () => {
  const fixture = await createFixture({
    musicTrackCount: 2,
    musicIds: ["primary", "reserve-a", "reserve-b"],
  });
  const plannedItems = fixture.plan.targets[0]!.result.items;

  // Simulate the unsafe case we explicitly do not want to legitimize: one
  // RESERVE identity moved into PRIMARY while the old PRIMARY moved into the
  // physical suffix.
  const physicalItems = [
    { ...plannedItems[1]!, position: 0 },
    { ...plannedItems[0]!, position: 1 },
    { ...plannedItems[2]!, position: 2 },
  ];
  await prisma.generationItem.createMany({
    data: physicalItems.map((item) => ({
      runId: fixture.runId,
      targetPlaylistId: fixture.targetId,
      position: item.position,
      contentType: item.type,
      spotifyUri: item.uri,
      title: item.title,
      durationMs: item.durationMs,
      spotifyTrackId: item.spotifyTrackId,
    })),
  });

  try {
    await assert.rejects(
      persistPlaybackReserveRolesAfterGeneration({
        runId: fixture.runId,
        state: fixture.state,
      }),
      /physical RESERVE suffix does not match selected reserve set/,
    );

    const rows = await prisma.generationPlanItemRole.findMany({
      where: { runId: fixture.runId },
    });
    assert.equal(rows.length, 0);
  } finally {
    await cleanupFixture(fixture);
  }
});
