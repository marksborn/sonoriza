import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  loadCalendarEventCompositionPolicy,
  saveCalendarEventCompositionPolicy,
} from "./calendar-event-composition-policy";

const databaseTest = process.env.CALENDAR_03_DB_TEST === "1" ? test : test.skip;

databaseTest(
  "missing row reads as backward-compatible defaults and save persists canonical policy",
  async () => {
    const suffix = randomUUID();
    const userId = `calendar03-user-${suffix}`;
    const targetPlaylistId = `calendar03-target-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "CALENDAR-03 integration fixture",
        durationMode: "CALENDAR",
        fixedDurationSeconds: null,
        calendarDurationStrategy: "PER_EVENT",
        sequencePattern: ["PODCAST", "MUSIC"],
      },
    });

    try {
      const defaults = await loadCalendarEventCompositionPolicy(
        userId,
        targetPlaylistId,
      );
      assert.deepEqual(defaults, {
        targetPlaylistId,
        eventCompositionPolicy: "INHERIT_DESTINATION",
        maxPodcastsPerEvent: 1,
        podcastEventSafetyMarginSeconds: 0,
        podcastEventDistribution: "EVERY_EVENT",
        podcastEveryNEvents: 1,
        podcastEventOffset: 0,
      });

      const rowCountBefore = await prisma.calendarEventCompositionPolicy.count({
        where: { userId, targetPlaylistId },
      });
      assert.equal(rowCountBefore, 0);

      const saved = await saveCalendarEventCompositionPolicy(
        userId,
        targetPlaylistId,
        {
          eventCompositionPolicy: "PODCAST_THEN_MUSIC",
          maxPodcastsPerEvent: 1,
          podcastEventSafetyMarginSeconds: 120,
          podcastEventDistribution: "EVERY_N_EVENTS",
          podcastEveryNEvents: 2,
          podcastEventOffset: 0,
        },
      );

      assert.deepEqual(saved, {
        targetPlaylistId,
        eventCompositionPolicy: "PODCAST_THEN_MUSIC",
        maxPodcastsPerEvent: 1,
        podcastEventSafetyMarginSeconds: 120,
        podcastEventDistribution: "EVERY_N_EVENTS",
        podcastEveryNEvents: 2,
        podcastEventOffset: 0,
      });

      assert.deepEqual(
        await loadCalendarEventCompositionPolicy(userId, targetPlaylistId),
        saved,
      );

      const row = await prisma.calendarEventCompositionPolicy.findUniqueOrThrow({
        where: {
          userId_targetPlaylistId: {
            userId,
            targetPlaylistId,
          },
        },
        select: {
          eventCompositionPolicy: true,
          maxPodcastsPerEvent: true,
          podcastEventSafetyMarginSeconds: true,
          podcastEventDistribution: true,
          podcastEveryNEvents: true,
          podcastEventOffset: true,
        },
      });

      assert.deepEqual(row, {
        eventCompositionPolicy: "PODCAST_THEN_MUSIC",
        maxPodcastsPerEvent: 1,
        podcastEventSafetyMarginSeconds: 120,
        podcastEventDistribution: "EVERY_N_EVENTS",
        podcastEveryNEvents: 2,
        podcastEventOffset: 0,
      });
    } finally {
      await prisma.calendarEventCompositionPolicy
        .deleteMany({ where: { userId, targetPlaylistId } })
        .catch(() => undefined);
      await prisma.targetPlaylist
        .delete({ where: { id: targetPlaylistId } })
        .catch(() => undefined);
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "store refuses to persist policy for a target owned by another user",
  async () => {
    const suffix = randomUUID();
    const ownerId = `calendar03-owner-${suffix}`;
    const otherUserId = `calendar03-other-${suffix}`;
    const targetPlaylistId = `calendar03-owned-target-${suffix}`;

    await prisma.user.createMany({
      data: [{ id: ownerId }, { id: otherUserId }],
    });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId: ownerId,
        name: "CALENDAR-03 ownership fixture",
        fixedDurationSeconds: 1800,
        sequencePattern: ["MUSIC"],
      },
    });

    try {
      await assert.rejects(
        () =>
          saveCalendarEventCompositionPolicy(otherUserId, targetPlaylistId, {
            eventCompositionPolicy: "PODCAST_THEN_MUSIC",
            maxPodcastsPerEvent: 1,
            podcastEventSafetyMarginSeconds: 0,
            podcastEventDistribution: "EVERY_EVENT",
          }),
        /does not belong to the user/,
      );

      assert.equal(
        await prisma.calendarEventCompositionPolicy.count({
          where: { targetPlaylistId },
        }),
        0,
      );
    } finally {
      await prisma.calendarEventCompositionPolicy
        .deleteMany({ where: { targetPlaylistId } })
        .catch(() => undefined);
      await prisma.targetPlaylist
        .delete({ where: { id: targetPlaylistId } })
        .catch(() => undefined);
      await prisma.user.deleteMany({
        where: { id: { in: [ownerId, otherUserId] } },
      });
    }
  },
);

databaseTest(
  "database constraints reject invalid persisted cycles even if contract is bypassed",
  async () => {
    const suffix = randomUUID();
    const userId = `calendar03-check-user-${suffix}`;
    const targetPlaylistId = `calendar03-check-target-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "CALENDAR-03 constraint fixture",
        fixedDurationSeconds: 900,
        sequencePattern: ["MUSIC"],
      },
    });

    try {
      await assert.rejects(() =>
        prisma.calendarEventCompositionPolicy.create({
          data: {
            userId,
            targetPlaylistId,
            eventCompositionPolicy: "PODCAST_THEN_MUSIC",
            maxPodcastsPerEvent: 1,
            podcastEventSafetyMarginSeconds: 0,
            podcastEventDistribution: "EVERY_N_EVENTS",
            podcastEveryNEvents: 2,
            podcastEventOffset: 2,
          },
        }),
      );
    } finally {
      await prisma.calendarEventCompositionPolicy
        .deleteMany({ where: { userId, targetPlaylistId } })
        .catch(() => undefined);
      await prisma.targetPlaylist
        .delete({ where: { id: targetPlaylistId } })
        .catch(() => undefined);
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "CALENDAR-04 persists SEQUENCE_PER_EVENT and switching back keeps the remainder choice",
  async () => {
    const suffix = randomUUID();
    const userId = `calendar04-user-${suffix}`;
    const targetPlaylistId = `calendar04-target-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "CALENDAR-04 integration fixture",
        durationMode: "CALENDAR",
        fixedDurationSeconds: null,
        calendarDurationStrategy: "PER_EVENT",
        sequencePattern: ["PODCAST", "MUSIC"],
      },
    });

    const legacyInput = {
      eventCompositionPolicy: "PODCAST_THEN_MUSIC" as const,
      maxPodcastsPerEvent: 1,
      podcastEventSafetyMarginSeconds: 0,
      podcastEventDistribution: "EVERY_N_EVENTS" as const,
      podcastEveryNEvents: 2,
      podcastEventOffset: 0,
    };

    try {
      await saveCalendarEventCompositionPolicy(userId, targetPlaylistId, legacyInput);
      const saved = await saveCalendarEventCompositionPolicy(userId, targetPlaylistId, {
        ...legacyInput,
        eventCompositionPolicy: "SEQUENCE_PER_EVENT",
        remainderFillStrategy: "MIX_RATIO",
        remainderPodcastPercent: 25,
        remainderFallback: "LEAVE_GAP",
      });
      assert.deepEqual(saved.sequencePerEvent, {
        remainderFillStrategy: "MIX_RATIO",
        remainderPodcastPercent: 25,
        remainderFallback: "LEAVE_GAP",
      });
      assert.deepEqual(
        await loadCalendarEventCompositionPolicy(userId, targetPlaylistId),
        saved,
      );

      const legacyAgain = await saveCalendarEventCompositionPolicy(
        userId,
        targetPlaylistId,
        legacyInput,
      );
      assert.equal("sequencePerEvent" in legacyAgain, false);
      const row = await prisma.calendarEventCompositionPolicy.findUniqueOrThrow({
        where: { userId_targetPlaylistId: { userId, targetPlaylistId } },
        select: {
          remainderFillStrategy: true,
          remainderPodcastPercent: true,
          remainderFallback: true,
        },
      });
      assert.deepEqual(row, {
        remainderFillStrategy: "MIX_RATIO",
        remainderPodcastPercent: 25,
        remainderFallback: "LEAVE_GAP",
      });

      await assert.rejects(
        prisma.$executeRaw`UPDATE "CalendarEventCompositionPolicy" SET "remainderPodcastPercent" = 101 WHERE "userId" = ${userId}`,
      );
    } finally {
      await prisma.calendarEventCompositionPolicy
        .deleteMany({ where: { userId, targetPlaylistId } })
        .catch(() => undefined);
      await prisma.targetPlaylist
        .delete({ where: { id: targetPlaylistId } })
        .catch(() => undefined);
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);
