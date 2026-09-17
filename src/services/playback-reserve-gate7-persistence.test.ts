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

databaseTest("Gate 7 persists explicit RESERVE role against the physical GenerationItem coordinate", async () => {
  const suffix = randomUUID();
  const userId = `reserve-gate7-persist-user-${suffix}`;
  const targetId = `reserve-gate7-persist-target-${suffix}`;
  const runId = `reserve-gate7-persist-run-${suffix}`;
  const policy: EffectivePlaybackReservePolicySnapshot = {
    targetPlaylistId: targetId,
    source: "GLOBAL",
    reserveMode: "MUSIC_TRACKS",
    durationSeconds: null,
    musicTrackCount: 1,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  };
  const state: PlaybackReserveShadowRuntimeState = {
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
    policies: new Map([[targetId, policy]]),
    simulationApprovalKey: "persist-test",
    simulationApprovedRunId: null,
    rolePersistenceStatus: "PENDING",
    reserveRoleCount: 0,
    evidence: null,
  };

  const plan = runWithPlaybackReserveShadowRuntimeState(state, () =>
    planRun({
      pools: { music: [music("primary"), music("reserve")], podcasts: [] },
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
  await prisma.generationItem.createMany({
    data: plan.targets[0]!.result.items.map((item) => ({
      runId,
      targetPlaylistId: targetId,
      position: item.position,
      contentType: item.type,
      spotifyUri: item.uri,
      title: item.title,
      durationMs: item.durationMs,
      spotifyTrackId: item.spotifyTrackId,
    })),
  });

  try {
    const count = await persistPlaybackReserveRolesAfterGeneration({ runId, state });
    assert.equal(count, 1);

    const rows = await prisma.generationPlanItemRole.findMany({
      where: { runId },
      orderBy: { position: "asc" },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, "RESERVE");
    assert.equal(rows[0]?.position, 1);
    assert.deepEqual(rows[0]?.reservePolicy, policy);
  } finally {
    await prisma.generationPlanItemRole.deleteMany({ where: { runId } });
    await prisma.generationRun.delete({ where: { id: runId } }).catch(() => undefined);
    await prisma.targetPlaylist.delete({ where: { id: targetId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});
