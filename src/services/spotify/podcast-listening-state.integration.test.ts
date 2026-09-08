import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { prismaPodcastListeningStateStore } from "./podcast-listening-state";

const databaseTest =
  process.env.PODCAST_LISTENING_STATE_DB_TEST === "1" ? test : test.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

databaseTest(
  "Prisma podcast store serializes observations on the canonical user row",
  async () => {
    const userId = `podcast-lock-${randomUUID()}`;
    await prisma.user.create({ data: { id: userId } });

    const pendingObservation = {
      current: undefined as
        | ReturnType<typeof prismaPodcastListeningStateStore.observe>
        | undefined,
    };
    let observationSettled = false;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "User"
          WHERE "id" = ${userId}
          FOR UPDATE
        `;

        pendingObservation.current = prismaPodcastListeningStateStore
          .observe(userId, [
            {
              spotifyEpisodeId: "episode-concurrent",
              spotifyUri: "spotify:episode:episode-concurrent",
              durationMs: 100_000,
              resumePositionMs: 100_000,
              fullyPlayed: true,
              observedAt: new Date("2026-08-09T18:00:00.000Z"),
            },
          ])
          .finally(() => {
            observationSettled = true;
          });

        await sleep(250);
        assert.equal(
          observationSettled,
          false,
          "observation must wait for the per-user canonical-state lock",
        );
      });

      const pending = pendingObservation.current;
      assert.ok(pending);
      const resolved = await pending;
      assert.equal(resolved.get("episode-concurrent")?.status, "COMPLETED");
      assert.equal(
        resolved.get("episode-concurrent")?.firstProgressObservedAt,
        null,
        "baseline completion must not invent a first-listening timestamp",
      );
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "Prisma podcast store persists an observed zero-to-progress transition without timezone drift",
  async () => {
    const userId = `podcast-progress-${randomUUID()}`;
    const episodeId = `episode-progress-${randomUUID()}`;
    const baselineAt = new Date("2026-09-08T12:00:00.000Z");
    const transitionAt = new Date("2026-09-08T13:15:27.123Z");
    const laterAt = new Date("2026-09-08T14:45:00.000Z");

    await prisma.user.create({ data: { id: userId } });

    try {
      await prismaPodcastListeningStateStore.observe(userId, [
        {
          spotifyEpisodeId: episodeId,
          spotifyUri: `spotify:episode:${episodeId}`,
          durationMs: 100_000,
          resumePositionMs: 0,
          fullyPlayed: false,
          observedAt: baselineAt,
        },
      ]);

      const baseline = await prisma.episodeListeningState.findUniqueOrThrow({
        where: {
          userId_spotifyEpisodeId: {
            userId,
            spotifyEpisodeId: episodeId,
          },
        },
      });

      assert.equal(baseline.firstProgressObservedAt, null);

      await prismaPodcastListeningStateStore.observe(userId, [
        {
          spotifyEpisodeId: episodeId,
          spotifyUri: `spotify:episode:${episodeId}`,
          durationMs: 100_000,
          resumePositionMs: 25_000,
          fullyPlayed: false,
          observedAt: transitionAt,
        },
      ]);

      const progressed = await prisma.episodeListeningState.findUniqueOrThrow({
        where: {
          userId_spotifyEpisodeId: {
            userId,
            spotifyEpisodeId: episodeId,
          },
        },
      });

      assert.equal(
        progressed.firstProgressObservedAt?.toISOString(),
        transitionAt.toISOString(),
        "persisted progress transition must preserve the exact UTC instant",
      );

      await prismaPodcastListeningStateStore.observe(userId, [
        {
          spotifyEpisodeId: episodeId,
          spotifyUri: `spotify:episode:${episodeId}`,
          durationMs: 100_000,
          resumePositionMs: 50_000,
          fullyPlayed: false,
          observedAt: laterAt,
        },
      ]);

      const later = await prisma.episodeListeningState.findUniqueOrThrow({
        where: {
          userId_spotifyEpisodeId: {
            userId,
            spotifyEpisodeId: episodeId,
          },
        },
      });

      assert.equal(
        later.firstProgressObservedAt?.toISOString(),
        transitionAt.toISOString(),
        "first progress timestamp must remain sticky after later observations",
      );
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);
