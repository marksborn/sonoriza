import assert from "node:assert/strict";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  parsePersistedPodcastDurationSlots,
} from "./podcast-duration-persistence";

const hasDatabase = Boolean(process.env.DATABASE_URL);

test("#365 Gate 3: Prisma stores global limits and per-target bands without rewriting legacy sequence", { skip: !hasDatabase }, async () => {
  const prisma = new PrismaClient();
  let userId: string | null = null;
  try {
    const user = await prisma.user.create({
      data: { name: "podcast08-integration-isolated" },
      select: { id: true },
    });
    userId = user.id;

    const settings = await prisma.podcastDurationBandSettings.create({
      data: { userId, shortMaxMinutes: 20, mediumMaxMinutes: 45 },
    });
    assert.equal(settings.shortMaxMinutes, 20);
    assert.equal(settings.mediumMaxMinutes, 45);

    const target = await prisma.targetPlaylist.create({
      data: {
        userId,
        name: "podcast08-test-sequence",
        sequencePattern: ["MUSIC", "PODCAST", "MUSIC", "PODCAST"],
      },
    });
    assert.equal(target.podcastDurationSlotBands, null);
    assert.deepEqual(parsePersistedPodcastDurationSlots(
      target.sequencePattern, target.podcastDurationSlotBands,
    ), ["ANY", "ANY", "ANY", "ANY"]);

    const updated = await prisma.targetPlaylist.update({
      where: { id: target.id },
      data: { podcastDurationSlotBands: ["ANY", "SHORT", "ANY", "LONG"] },
    });
    assert.deepEqual(updated.sequencePattern, [
      "MUSIC", "PODCAST", "MUSIC", "PODCAST",
    ]);
    assert.deepEqual(updated.podcastDurationSlotBands, [
      "ANY", "SHORT", "ANY", "LONG",
    ]);
  } finally {
    if (userId !== null) {
      await prisma.user.delete({ where: { id: userId } });
    }
    await prisma.$disconnect();
  }
});
