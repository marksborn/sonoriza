import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { dailyScheduleSlot } from "@/services/target-schedule";

import { claimScheduleSlot } from "./scheduled-generation";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

// The scheduler under test runs as PM2 instance "standalone" with a fresh
// owner id; the seeded attempt belongs to a previous (dead) process of the
// same instance, exactly as after a max_memory_restart.
const PREVIOUS_PROCESS_DETAILS = {
  schedulerOwnerId: "standalone:1:previous-process",
  schedulerInstanceId: "standalone",
  checkpoint: "CLAIMED",
};

async function seedDeadAttempt(checkpoints: string[]) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: { email: `restart-takeover-${suffix}@example.test` },
  });
  const target = await prisma.targetPlaylist.create({
    data: {
      userId: user.id,
      name: "Carro",
      spotifyPlaylistId: `playlist-takeover-${suffix}`,
      priority: 0,
      durationMode: "FIXED",
      fixedDurationSeconds: 300,
      podcastPercent: 0,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 1,
      updatePolicy: "KEEP_FILLED",
      dailyScheduleMinutes: 360,
      scheduleTimezone: "America/Sao_Paulo",
    },
  });

  // 06:03 BRT: three minutes after the attempt started, far inside the
  // 30 min stale window.
  const now = new Date("2026-10-09T09:03:00.000Z");
  const startedAt = new Date("2026-10-09T09:00:00.000Z");
  const slot = dailyScheduleSlot(target.id, 360, "America/Sao_Paulo", now);

  const run = await prisma.generationRun.create({
    data: { userId: user.id, trigger: "SCHEDULED", status: "RUNNING", startedAt },
  });
  for (const name of checkpoints) {
    await prisma.generationLog.create({
      data: { runId: run.id, message: `Checkpoint ${name}`, data: { checkpoint: name } },
    });
  }
  const scheduleRun = await prisma.targetScheduleRun.create({
    data: {
      userId: user.id,
      targetPlaylistId: target.id,
      scheduleKey: slot.scheduleKey,
      scheduledLocalDate: slot.localDate,
      scheduledForMinutes: 360,
      scheduleTimezone: "America/Sao_Paulo",
      policy: "KEEP_FILLED",
      status: "RUNNING",
      attempt: 1,
      generationRunId: run.id,
      startedAt,
    },
  });
  await prisma.targetScheduleAttempt.create({
    data: {
      targetScheduleRunId: scheduleRun.id,
      attempt: 1,
      status: "RUNNING",
      generationRunId: run.id,
      details: PREVIOUS_PROCESS_DETAILS,
      startedAt,
    },
  });

  return { user, target, slot, now, run, scheduleRun };
}

integrationTest(
  "#435 Gate 3G restart takes over a linked run that died before PROVIDER_WRITE_START",
  { concurrency: false },
  async (t) => {
    const seeded = await seedDeadAttempt([
      "RUN_CREATED",
      "CALENDAR_READ_START",
      "CALENDAR_READ_DONE",
      "SOURCE_READ_START",
    ]);
    t.after(async () => {
      await prisma.user.delete({ where: { id: seeded.user.id } });
    });

    const claimed = await claimScheduleSlot(
      seeded.user.id,
      seeded.target,
      seeded.slot,
      seeded.now,
    );

    assert.ok(claimed, "slot must be reclaimed immediately after restart");
    assert.equal(claimed.attempt, 2);
    assert.equal(claimed.status, "RUNNING");

    const previous = await prisma.targetScheduleAttempt.findUniqueOrThrow({
      where: {
        targetScheduleRunId_attempt: { targetScheduleRunId: seeded.scheduleRun.id, attempt: 1 },
      },
    });
    assert.equal(previous.status, "FAILED");
    assert.match(previous.reason ?? "", /reinício do processo/);

    const deadRun = await prisma.generationRun.findUniqueOrThrow({
      where: { id: seeded.run.id },
      include: { logs: { orderBy: { createdAt: "asc" } } },
    });
    assert.equal(deadRun.status, "FAILED");
    assert.equal(deadRun.logs.at(-1)?.message, "Checkpoint PROCESS_RESTART_TERMINALIZED");
  },
);

integrationTest(
  "#435 Gate 3G restart keeps the stale window when the dead run reached PROVIDER_WRITE_START",
  { concurrency: false },
  async (t) => {
    const seeded = await seedDeadAttempt([
      "RUN_CREATED",
      "PREWRITE_DONE",
      "PROVIDER_WRITE_START",
    ]);
    t.after(async () => {
      await prisma.user.delete({ where: { id: seeded.user.id } });
    });

    const claimed = await claimScheduleSlot(
      seeded.user.id,
      seeded.target,
      seeded.slot,
      seeded.now,
    );

    assert.equal(claimed, null, "a possibly in-flight write must not be retried early");
    const attempt = await prisma.targetScheduleAttempt.findUniqueOrThrow({
      where: {
        targetScheduleRunId_attempt: { targetScheduleRunId: seeded.scheduleRun.id, attempt: 1 },
      },
    });
    assert.equal(attempt.status, "RUNNING");
    const run = await prisma.generationRun.findUniqueOrThrow({ where: { id: seeded.run.id } });
    assert.equal(run.status, "RUNNING");
  },
);

integrationTest(
  "#435 Gate 3G restart keeps the stale window when the dead run has no checkpoints",
  { concurrency: false },
  async (t) => {
    const seeded = await seedDeadAttempt([]);
    t.after(async () => {
      await prisma.user.delete({ where: { id: seeded.user.id } });
    });

    const claimed = await claimScheduleSlot(
      seeded.user.id,
      seeded.target,
      seeded.slot,
      seeded.now,
    );
    assert.equal(claimed, null);
  },
);
