import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { assessConfiguration } from "@/services/configuration-readiness";

import { assessCalendar03GenerationConfiguration } from "./calendar-event-composition-generation";

const databaseTest = process.env.CALENDAR_03_DB_TEST === "1" ? test : test.skip;

databaseTest("default-equivalent policy does not churn fingerprint; semantic changes do", async () => {
  const suffix = randomUUID();
  const userId = `calendar03-g3-user-${suffix}`;
  const targetId = `calendar03-g3-target-${suffix}`;

  await prisma.user.create({ data: { id: userId } });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "Gate 3 fingerprint target",
      durationMode: "CALENDAR",
      fixedDurationSeconds: null,
      calendarDurationStrategy: "PER_EVENT",
      sequencePattern: ["PODCAST", "MUSIC"],
    },
  });

  try {
    const base = await assessConfiguration(userId);
    const before = await assessCalendar03GenerationConfiguration(userId, base);

    await prisma.calendarEventCompositionPolicy.create({
      data: {
        userId,
        targetPlaylistId: targetId,
        eventCompositionPolicy: "INHERIT_DESTINATION",
        maxPodcastsPerEvent: 1,
        podcastEventSafetyMarginSeconds: 0,
        podcastEventDistribution: "EVERY_EVENT",
        podcastEveryNEvents: 1,
        podcastEventOffset: 0,
      },
    });

    const defaultRow = await assessCalendar03GenerationConfiguration(
      userId,
      await assessConfiguration(userId),
    );
    assert.equal(
      defaultRow.assessment.fingerprint,
      before.assessment.fingerprint,
      "persisting the canonical default must not invalidate a simulation",
    );

    await prisma.calendarEventCompositionPolicy.update({
      where: {
        userId_targetPlaylistId: { userId, targetPlaylistId: targetId },
      },
      data: {
        eventCompositionPolicy: "PODCAST_THEN_MUSIC",
        podcastEventSafetyMarginSeconds: 120,
        podcastEventDistribution: "EVERY_N_EVENTS",
        podcastEveryNEvents: 2,
        podcastEventOffset: 1,
      },
    });

    const active = await assessCalendar03GenerationConfiguration(
      userId,
      await assessConfiguration(userId),
    );
    assert.notEqual(active.assessment.fingerprint, before.assessment.fingerprint);
    assert.deepEqual(active.fingerprintPolicies, [
      {
        targetPlaylistId: targetId,
        eventCompositionPolicy: "PODCAST_THEN_MUSIC",
        maxPodcastsPerEvent: 1,
        podcastEventSafetyMarginSeconds: 120,
        podcastEventDistribution: "EVERY_N_EVENTS",
        podcastEveryNEvents: 2,
        podcastEventOffset: 1,
      },
    ]);
  } finally {
    await prisma.calendarEventCompositionPolicy.deleteMany({ where: { userId } });
    await prisma.targetPlaylist.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

databaseTest("PODCAST_THEN_MUSIC fails readiness when target is not CALENDAR/PER_EVENT", async () => {
  const suffix = randomUUID();
  const userId = `calendar03-g3-invalid-user-${suffix}`;
  const targetId = `calendar03-g3-invalid-target-${suffix}`;

  await prisma.user.create({ data: { id: userId } });
  await prisma.targetPlaylist.create({
    data: {
      id: targetId,
      userId,
      name: "Gate 3 invalid target",
      durationMode: "FIXED",
      fixedDurationSeconds: 1800,
      calendarDurationStrategy: "SUMMED",
      sequencePattern: ["MUSIC"],
    },
  });
  await prisma.calendarEventCompositionPolicy.create({
    data: {
      userId,
      targetPlaylistId: targetId,
      eventCompositionPolicy: "PODCAST_THEN_MUSIC",
      maxPodcastsPerEvent: 1,
      podcastEventSafetyMarginSeconds: 0,
      podcastEventDistribution: "EVERY_EVENT",
      podcastEveryNEvents: 1,
      podcastEventOffset: 0,
    },
  });

  try {
    const configuration = await assessCalendar03GenerationConfiguration(
      userId,
      await assessConfiguration(userId),
    );
    assert.ok(
      configuration.assessment.issues.some(
        (issue) => issue.code === `CALENDAR03_PER_EVENT_REQUIRED:${targetId}`,
      ),
    );
  } finally {
    await prisma.calendarEventCompositionPolicy.deleteMany({ where: { userId } });
    await prisma.targetPlaylist.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});
