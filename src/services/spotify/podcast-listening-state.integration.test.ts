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
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);
