import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  ORPHAN_TERMINALIZED_REASON,
  findOrphanGenerationRuns,
  terminalizeOrphanGenerationRuns,
} from "./orphan-generation-runs";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "#435 orphan sweep terminalizes only old RUNNING runs without a live scheduler attempt",
  { concurrency: false },
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `orphan-sweep-${suffix}@example.test` },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const now = new Date("2026-10-08T12:00:00.000Z");
    const old = new Date("2026-10-01T09:00:00.000Z");
    const recent = new Date(now.getTime() - 30 * 60 * 1000);

    const orphanScheduled = await prisma.generationRun.create({
      data: { userId: user.id, trigger: "SCHEDULED", status: "RUNNING", startedAt: old },
    });
    await prisma.generationLog.create({
      data: {
        runId: orphanScheduled.id,
        message: "Checkpoint SOURCE_READ_START",
        data: { checkpoint: "SOURCE_READ_START" },
      },
    });
    const orphanSimulation = await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "SIMULATION",
        simulation: true,
        status: "RUNNING",
        startedAt: old,
      },
    });
    const tooRecent = await prisma.generationRun.create({
      data: { userId: user.id, trigger: "SCHEDULED", status: "RUNNING", startedAt: recent },
    });
    const finished = await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "SCHEDULED",
        status: "SUCCESS",
        startedAt: old,
        finishedAt: old,
      },
    });
    const ownedByLiveAttempt = await prisma.generationRun.create({
      data: { userId: user.id, trigger: "SCHEDULED", status: "RUNNING", startedAt: old },
    });

    const target = await prisma.targetPlaylist.create({
      data: {
        userId: user.id,
        name: "Carro",
        spotifyPlaylistId: `playlist-orphan-${suffix}`,
        priority: 0,
        durationMode: "FIXED",
        fixedDurationSeconds: 300,
        podcastPercent: 0,
        sequencePattern: ["MUSIC"],
        maxEpisodesPerProgram: 1,
      },
    });
    const scheduleRun = await prisma.targetScheduleRun.create({
      data: {
        userId: user.id,
        targetPlaylistId: target.id,
        scheduleKey: `orphan-${suffix}`,
        scheduledLocalDate: "2026-10-01",
        scheduledForMinutes: 360,
        scheduleTimezone: "America/Sao_Paulo",
        policy: "KEEP_FILLED",
        status: "RUNNING",
        generationRunId: ownedByLiveAttempt.id,
        startedAt: old,
      },
    });
    await prisma.targetScheduleAttempt.create({
      data: {
        targetScheduleRunId: scheduleRun.id,
        attempt: 1,
        status: "RUNNING",
        generationRunId: ownedByLiveAttempt.id,
        startedAt: old,
      },
    });

    const ownIds = new Set([
      orphanScheduled.id,
      orphanSimulation.id,
      tooRecent.id,
      finished.id,
      ownedByLiveAttempt.id,
    ]);
    const orphans = (await findOrphanGenerationRuns(now)).filter((orphan) =>
      ownIds.has(orphan.id),
    );

    assert.deepEqual(
      orphans.map((orphan) => orphan.id).sort(),
      [orphanScheduled.id, orphanSimulation.id].sort(),
    );
    assert.equal(
      orphans.find((orphan) => orphan.id === orphanScheduled.id)?.lastCheckpoint,
      "SOURCE_READ_START",
    );

    const terminalized = await terminalizeOrphanGenerationRuns(orphans, now);
    assert.deepEqual(terminalized.sort(), [orphanScheduled.id, orphanSimulation.id].sort());

    const closed = await prisma.generationRun.findUniqueOrThrow({
      where: { id: orphanScheduled.id },
      include: { logs: { orderBy: { createdAt: "asc" } } },
    });
    assert.equal(closed.status, "FAILED");
    assert.equal(closed.finishedAt?.toISOString(), now.toISOString());
    assert.equal(closed.error, ORPHAN_TERMINALIZED_REASON);
    assert.equal(closed.logs.at(-1)?.message, "Checkpoint ORPHAN_TERMINALIZED");

    // Untouched rows keep their state.
    for (const id of [tooRecent.id, ownedByLiveAttempt.id]) {
      const run = await prisma.generationRun.findUniqueOrThrow({ where: { id } });
      assert.equal(run.status, "RUNNING");
      assert.equal(run.finishedAt, null);
    }
    const stillSuccess = await prisma.generationRun.findUniqueOrThrow({
      where: { id: finished.id },
    });
    assert.equal(stillSuccess.status, "SUCCESS");

    // Idempotent: a second pass finds and changes nothing of ours.
    const again = (await findOrphanGenerationRuns(now)).filter((orphan) =>
      ownIds.has(orphan.id),
    );
    assert.deepEqual(again, []);
    assert.deepEqual(await terminalizeOrphanGenerationRuns(orphans, now), []);
  },
);
