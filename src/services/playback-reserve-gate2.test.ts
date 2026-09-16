import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { assessConfiguration } from "./configuration-readiness";
import {
  loadGenerationPlanItemRoles,
  persistGenerationPlanItemRole,
  playbackReserveFingerprintPayloadFragment,
  type PlaybackReserveFingerprintEntry,
} from "./playback-reserve-gate2";
import {
  savePlaybackReservePolicy,
  saveTargetPlaybackReservePolicy,
} from "./playback-reserve-policy";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function entry(
  overrides: Partial<PlaybackReserveFingerprintEntry> = {},
): PlaybackReserveFingerprintEntry {
  return {
    targetPlaylistId: "target-a",
    source: "GLOBAL",
    reserveMode: "NONE",
    durationSeconds: null,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
    ...overrides,
  };
}

test("Gate 2 omits an all-NONE reserve fragment so legacy fingerprints remain stable", () => {
  const base = { providers: ["spotify"], targets: ["target-a"] };
  const fragment = playbackReserveFingerprintPayloadFragment([
    entry(),
    entry({ targetPlaylistId: "target-b", source: "TARGET_OVERRIDE" }),
  ]);

  assert.deepEqual(fragment, {});
  assert.equal(hash({ ...base, ...fragment }), hash(base));
});

test("Gate 2 fingerprints complete target-local policy including source and explicit NONE overrides", () => {
  const fragment = playbackReserveFingerprintPayloadFragment([
    entry({
      targetPlaylistId: "target-b",
      source: "TARGET_OVERRIDE",
      reserveMode: "NONE",
    }),
    entry({
      targetPlaylistId: "target-a",
      source: "GLOBAL",
      reserveMode: "DURATION",
      durationSeconds: 900,
      podcastInDurationReserve: "IF_FITS",
    }),
  ]) as {
    playbackReservePolicies: PlaybackReserveFingerprintEntry[];
  };

  assert.deepEqual(
    fragment.playbackReservePolicies.map((policy) => ({
      targetPlaylistId: policy.targetPlaylistId,
      source: policy.source,
      reserveMode: policy.reserveMode,
    })),
    [
      {
        targetPlaylistId: "target-a",
        source: "GLOBAL",
        reserveMode: "DURATION",
      },
      {
        targetPlaylistId: "target-b",
        source: "TARGET_OVERRIDE",
        reserveMode: "NONE",
      },
    ],
  );
});

test("Gate 2 stays outside productive planner/publication paths", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );
  const readiness = readFileSync(
    "src/services/configuration-readiness.ts",
    "utf8",
  );

  assert.doesNotMatch(generator, /playback-reserve-gate2/);
  assert.doesNotMatch(generator, /generationPlanItemRole/);
  assert.match(readiness, /loadPlaybackReserveFingerprintEntries/);
  assert.match(readiness, /playbackReserveFingerprintPayloadFragment/);
});

databaseTest(
  "configuration fingerprint changes only when effective reserve policy can affect a target",
  async () => {
    const suffix = randomUUID();
    const userId = `reserve-gate2-fingerprint-user-${suffix}`;
    const targetA = `reserve-gate2-target-a-${suffix}`;
    const targetB = `reserve-gate2-target-b-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.createMany({
      data: [
        {
          id: targetA,
          userId,
          name: "Gate 2 target A",
          fixedDurationSeconds: 3600,
          sequencePattern: ["MUSIC"],
        },
        {
          id: targetB,
          userId,
          name: "Gate 2 target B",
          fixedDurationSeconds: 3600,
          sequencePattern: ["MUSIC"],
        },
      ],
    });

    try {
      const baseline = (await assessConfiguration(userId)).fingerprint;

      await savePlaybackReservePolicy(userId, {
        reserveMode: "DURATION",
        durationSeconds: 900,
        podcastInDurationReserve: "IF_FITS",
      });
      const globalDuration = (await assessConfiguration(userId)).fingerprint;
      assert.notEqual(globalDuration, baseline);

      await saveTargetPlaybackReservePolicy(userId, targetA, {
        policyMode: "OVERRIDE",
        reserveMode: "NONE",
      });
      const oneTargetDisabled = (await assessConfiguration(userId)).fingerprint;
      assert.notEqual(oneTargetDisabled, globalDuration);

      await savePlaybackReservePolicy(userId, {
        reserveMode: "DURATION",
        durationSeconds: 1200,
        podcastInDurationReserve: "IF_FITS",
      });
      const changedDuration = (await assessConfiguration(userId)).fingerprint;
      assert.notEqual(changedDuration, oneTargetDisabled);

      await savePlaybackReservePolicy(userId, { reserveMode: "NONE" });
      const allEffectiveNone = (await assessConfiguration(userId)).fingerprint;
      assert.equal(allEffectiveNone, baseline);
    } finally {
      await prisma.targetPlaybackReservePolicy.deleteMany({ where: { userId } });
      await prisma.playbackReservePolicy.deleteMany({ where: { userId } });
      await prisma.targetPlaylist.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "plan role sidecar persists PRIMARY and RESERVE explicitly with reserve provenance",
  async () => {
    const suffix = randomUUID();
    const userId = `reserve-gate2-role-user-${suffix}`;
    const targetPlaylistId = `reserve-gate2-role-target-${suffix}`;
    const runId = `reserve-gate2-role-run-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "Gate 2 plan-role target",
        fixedDurationSeconds: 3600,
        sequencePattern: ["MUSIC"],
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
      data: [
        {
          runId,
          targetPlaylistId,
          position: 0,
          contentType: "MUSIC",
          spotifyUri: "spotify:track:gate2-primary",
        },
        {
          runId,
          targetPlaylistId,
          position: 1,
          contentType: "MUSIC",
          spotifyUri: "spotify:track:gate2-reserve",
        },
      ],
    });

    try {
      await persistGenerationPlanItemRole({
        runId,
        targetPlaylistId,
        position: 0,
      });
      await persistGenerationPlanItemRole({
        runId,
        targetPlaylistId,
        position: 1,
        role: "RESERVE",
        reservePolicy: {
          targetPlaylistId,
          source: "GLOBAL",
          reserveMode: "DURATION",
          durationSeconds: 900,
          musicTrackCount: null,
          podcastEpisodeCount: null,
          podcastInDurationReserve: "IF_FITS",
        },
      });

      const rows = await loadGenerationPlanItemRoles(runId, targetPlaylistId);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.role, "PRIMARY");
      assert.equal(rows[0]?.reservePolicy, null);
      assert.equal(rows[1]?.role, "RESERVE");
      assert.deepEqual(rows[1]?.reservePolicy, {
        targetPlaylistId,
        source: "GLOBAL",
        reserveMode: "DURATION",
        durationSeconds: 900,
        musicTrackCount: null,
        podcastEpisodeCount: null,
        podcastInDurationReserve: "IF_FITS",
      });

      await assert.rejects(
        () =>
          persistGenerationPlanItemRole({
            runId,
            targetPlaylistId,
            position: 2,
            role: "RESERVE",
            reservePolicy: {
              targetPlaylistId,
              source: "GLOBAL",
              reserveMode: "NONE",
              durationSeconds: null,
              musicTrackCount: null,
              podcastEpisodeCount: null,
              podcastInDurationReserve: "DISABLED",
            },
          }),
        /cannot be produced by reserveMode NONE/,
      );

      await assert.rejects(() =>
        prisma.generationPlanItemRole.create({
          data: {
            runId,
            targetPlaylistId,
            position: 3,
            role: "RESERVE",
            reservePolicy: Prisma.JsonNull,
          },
        }),
      );
    } finally {
      await prisma.generationPlanItemRole.deleteMany({ where: { runId } });
      await prisma.generationRun.delete({ where: { id: runId } }).catch(() => undefined);
      await prisma.targetPlaylist
        .delete({ where: { id: targetPlaylistId } })
        .catch(() => undefined);
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);
