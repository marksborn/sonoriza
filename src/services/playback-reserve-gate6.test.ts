import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { readMusicExposureModel } from "@/services/music-exposure/read-model";
import { loadPublishedMusicRun } from "@/services/music-preference/lastfm-coverage-prisma";

import { persistGenerationPlanItemRole } from "./playback-reserve-gate2";
import {
  buildGenerationPlanItemRoleIndex,
  generationPlanItemParticipatesInBehavioralEvidence,
  generationPlanItemRoleCoordinateKey,
  resolveGenerationPlanItemRole,
} from "./playback-reserve-gate6";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;

test("Gate 6 defaults missing role to PRIMARY and excludes explicit RESERVE", () => {
  assert.equal(generationPlanItemParticipatesInBehavioralEvidence(undefined), true);
  assert.equal(generationPlanItemParticipatesInBehavioralEvidence(null), true);
  assert.equal(generationPlanItemParticipatesInBehavioralEvidence("PRIMARY"), true);
  assert.equal(generationPlanItemParticipatesInBehavioralEvidence("RESERVE"), false);

  const index = buildGenerationPlanItemRoleIndex([
    {
      runId: "run",
      targetPlaylistId: "target-a",
      position: 4,
      role: "RESERVE",
    },
  ]);

  assert.equal(
    resolveGenerationPlanItemRole(index, {
      runId: "run",
      targetPlaylistId: "target-a",
      position: 4,
    }),
    "RESERVE",
  );
  assert.equal(
    resolveGenerationPlanItemRole(index, {
      runId: "run",
      targetPlaylistId: "target-b",
      position: 4,
    }),
    "PRIMARY",
    "same position in another target must not inherit RESERVE role",
  );
  assert.notEqual(
    generationPlanItemRoleCoordinateKey({
      runId: "run",
      targetPlaylistId: "target-a",
      position: 4,
    }),
    generationPlanItemRoleCoordinateKey({
      runId: "run",
      targetPlaylistId: "target-b",
      position: 4,
    }),
  );
});

databaseTest(
  "Gate 6 keeps RESERVE out of MUSIC-06 sequence and MUSIC-07 exposure ledger",
  async () => {
    const suffix = randomUUID();
    const userId = `reserve-gate6-user-${suffix}`;
    const targetA = `reserve-gate6-target-a-${suffix}`;
    const targetB = `reserve-gate6-target-b-${suffix}`;
    const runId = `reserve-gate6-run-${suffix}`;
    const now = new Date();
    const startedAt = new Date(now.getTime() - 10 * 60_000);
    const finishedAt = new Date(now.getTime() - 5 * 60_000);

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.createMany({
      data: [
        {
          id: targetA,
          userId,
          name: "Gate 6 target A",
          fixedDurationSeconds: 3600,
          sequencePattern: ["MUSIC"],
        },
        {
          id: targetB,
          userId,
          name: "Gate 6 target B",
          fixedDurationSeconds: 3600,
          sequencePattern: ["MUSIC"],
        },
      ],
    });
    await prisma.generationRun.create({
      data: {
        id: runId,
        userId,
        trigger: "MANUAL",
        simulation: false,
        status: "SUCCESS",
        startedAt,
        finishedAt,
        summary: {
          targets: [
            { targetPlaylistId: targetA, applied: true },
            { targetPlaylistId: targetB, applied: true },
          ],
        },
      },
    });
    await prisma.generationItem.createMany({
      data: [
        {
          runId,
          targetPlaylistId: targetA,
          position: 0,
          contentType: "MUSIC",
          spotifyUri: "spotify:track:gate6-a-primary",
          spotifyTrackId: "gate6-a-primary",
          title: "A primary",
          subtitle: "Artist A",
        },
        {
          runId,
          targetPlaylistId: targetA,
          position: 1,
          contentType: "MUSIC",
          spotifyUri: "spotify:track:gate6-a-reserve-1",
          spotifyTrackId: "gate6-a-reserve-1",
          title: "A reserve 1",
          subtitle: "Artist A",
        },
        {
          runId,
          targetPlaylistId: targetA,
          position: 2,
          contentType: "MUSIC",
          spotifyUri: "spotify:track:gate6-a-reserve-2",
          spotifyTrackId: "gate6-a-reserve-2",
          title: "A reserve 2",
          subtitle: "Artist A",
        },
        {
          runId,
          targetPlaylistId: targetB,
          position: 1,
          contentType: "MUSIC",
          spotifyUri: "spotify:track:gate6-b-primary",
          spotifyTrackId: "gate6-b-primary",
          title: "B primary",
          subtitle: "Artist B",
        },
      ],
    });

    const reservePolicy = {
      targetPlaylistId: targetA,
      source: "GLOBAL" as const,
      reserveMode: "MUSIC_TRACKS" as const,
      durationSeconds: null,
      musicTrackCount: 2,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "DISABLED" as const,
    };

    try {
      await persistGenerationPlanItemRole({
        runId,
        targetPlaylistId: targetA,
        position: 1,
        role: "RESERVE",
        reservePolicy,
      });
      await persistGenerationPlanItemRole({
        runId,
        targetPlaylistId: targetA,
        position: 2,
        role: "RESERVE",
        reservePolicy,
      });

      const music06 = await loadPublishedMusicRun(userId, runId);
      const music06ByTarget = new Map(
        music06.targets.map((target) => [target.targetPlaylistId, target] as const),
      );
      assert.deepEqual(
        music06ByTarget.get(targetA)?.occurrences.map((row) => row.position),
        [0],
        "unreached RESERVE suffix must not enter MUSIC-06 planned sequence",
      );
      assert.deepEqual(
        music06ByTarget.get(targetB)?.occurrences.map((row) => row.position),
        [1],
        "RESERVE role in target A must not leak to the same position in target B",
      );

      const previousApiKey = process.env.LASTFM_API_KEY;
      const previousUsername = process.env.LASTFM_USERNAME;
      process.env.LASTFM_API_KEY = "";
      process.env.LASTFM_USERNAME = "";
      try {
        const music07 = await readMusicExposureModel({
          userId,
          from: new Date(startedAt.getTime() - 60_000),
          to: now,
        });
        assert.equal(music07.diagnostics.identityReadyItemCount, 2);
        assert.equal(music07.diagnostics.reserveRoleExcludedItemCount, 2);
        assert.equal(music07.diagnostics.measurableTargetSnapshotCount, 2);
        assert.equal(music07.report.publicationCount, 2);
        assert.equal(
          music07.report.events.some((event) => event.trackName.startsWith("A reserve")),
          false,
          "publishing RESERVE must not create a MUSIC-07 exposure event",
        );
      } finally {
        restoreEnv("LASTFM_API_KEY", previousApiKey);
        restoreEnv("LASTFM_USERNAME", previousUsername);
      }
    } finally {
      await prisma.generationPlanItemRole.deleteMany({ where: { runId } });
      await prisma.generationRun.delete({ where: { id: runId } }).catch(() => undefined);
      await prisma.targetPlaylist.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

function restoreEnv(name: "LASTFM_API_KEY" | "LASTFM_USERNAME", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
