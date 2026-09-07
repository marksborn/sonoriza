import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { savePodcastShowPolicy } from "./podcast-show-policy-store";

const databaseTest = process.env.PODCAST_06_DB_TEST === "1" ? test : test.skip;

databaseTest(
  "legacy PODCAST-05 save preserves persisted PODCAST-06 cadence and priority",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast06-user-${suffix}`;
    const sourcePlaylistId = `podcast06-source-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.create({
      data: {
        id: sourcePlaylistId,
        userId,
        kind: "PODCAST",
        spotifyType: "SHOW",
        spotifyId: `show-${suffix}`,
        name: "PODCAST-06 integration fixture",
      },
    });
    await prisma.podcastShowPolicy.create({
      data: {
        sourcePlaylistId,
        cadenceMaxEpisodes: 2,
        cadenceUnit: "WEEK",
        priority: "PRIORITY",
      },
    });

    try {
      const saved = await savePodcastShowPolicy(userId, sourcePlaylistId, {
        episodeEligibility: "UNPLAYED_ONLY",
        episodeOrder: "OLDEST_FIRST",
        randomPolicy: "WITHOUT_REPLACEMENT",
        startEpisodeId: null,
        strictSequence: true,
        maxReleaseAgeDays: null,
        expiryPolicy: "STRICT_EXPIRY",
        maxEpisodesPerCycle: 1,
      });

      assert.equal(saved, true);

      const policy = await prisma.podcastShowPolicy.findUniqueOrThrow({
        where: { sourcePlaylistId },
        select: {
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          priority: true,
          maxEpisodesPerCycle: true,
        },
      });

      assert.deepEqual(policy, {
        cadenceMaxEpisodes: 2,
        cadenceUnit: "WEEK",
        priority: "PRIORITY",
        maxEpisodesPerCycle: 1,
      });
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);
