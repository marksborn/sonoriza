import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  loadPodcastShowCadencePolicies,
  savePodcastShowCadencePolicy,
} from "./podcast-show-cadence-policy-store";
import {
  loadPodcastShowPolicies,
  savePodcastShowPolicy,
} from "./podcast-show-policy-store";

const databaseTest = process.env.PODCAST_06_DB_TEST === "1" ? test : test.skip;

function podcast05Input() {
  return {
    episodeEligibility: "UNPLAYED_ONLY" as const,
    episodeOrder: "OLDEST_FIRST" as const,
    randomPolicy: "WITHOUT_REPLACEMENT" as const,
    startEpisodeId: null,
    strictSequence: true,
    maxReleaseAgeDays: null,
    expiryPolicy: "STRICT_EXPIRY" as const,
    maxEpisodesPerCycle: 1,
  };
}

databaseTest(
  "legacy PODCAST-05 save preserves source-independent PODCAST-06 cadence and priority",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast06-user-${suffix}`;
    const sourcePlaylistId = `podcast06-source-${suffix}`;
    const spotifyShowId = `show-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.create({
      data: {
        id: sourcePlaylistId,
        userId,
        kind: "PODCAST",
        spotifyType: "SHOW",
        spotifyId: spotifyShowId,
        name: "PODCAST-06 integration fixture",
      },
    });
    await prisma.podcastShowCadencePolicy.create({
      data: {
        userId,
        spotifyShowId,
        showName: "PODCAST-06 integration fixture",
        cadenceMaxEpisodes: 2,
        cadenceUnit: "WEEK",
        priority: "PRIORITY",
      },
    });

    try {
      const saved = await savePodcastShowPolicy(
        userId,
        sourcePlaylistId,
        podcast05Input(),
      );
      assert.equal(saved, true);

      const cadence = await prisma.podcastShowCadencePolicy.findUniqueOrThrow({
        where: { userId_spotifyShowId: { userId, spotifyShowId } },
        select: {
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          priority: true,
        },
      });
      assert.deepEqual(cadence, {
        cadenceMaxEpisodes: 2,
        cadenceUnit: "WEEK",
        priority: "PRIORITY",
      });

      const legacy = await prisma.podcastShowPolicy.findUniqueOrThrow({
        where: { sourcePlaylistId },
        select: {
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          priority: true,
          maxEpisodesPerCycle: true,
        },
      });
      assert.deepEqual(legacy, {
        cadenceMaxEpisodes: null,
        cadenceUnit: null,
        priority: "NORMAL",
        maxEpisodesPerCycle: 1,
      });

      const explicitShowReadModel = await loadPodcastShowPolicies(userId);
      assert.deepEqual(
        {
          cadenceMaxEpisodes:
            explicitShowReadModel.get(sourcePlaylistId)?.cadenceMaxEpisodes,
          cadenceUnit: explicitShowReadModel.get(sourcePlaylistId)?.cadenceUnit,
          priority: explicitShowReadModel.get(sourcePlaylistId)?.priority,
        },
        {
          cadenceMaxEpisodes: 2,
          cadenceUnit: "WEEK",
          priority: "PRIORITY",
        },
      );
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "explicit SHOW writer stores PODCAST-06 fields only in global show policy",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast06-write-user-${suffix}`;
    const sourcePlaylistId = `podcast06-write-source-${suffix}`;
    const spotifyShowId = `show-write-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.create({
      data: {
        id: sourcePlaylistId,
        userId,
        kind: "PODCAST",
        spotifyType: "SHOW",
        spotifyId: spotifyShowId,
        name: "Cross-source writer fixture",
      },
    });

    try {
      const saved = await savePodcastShowPolicy(userId, sourcePlaylistId, {
        ...podcast05Input(),
        cadenceMaxEpisodes: 3,
        cadenceUnit: "MONTH",
        priority: "PRIORITY",
      });
      assert.equal(saved, true);

      const global = await prisma.podcastShowCadencePolicy.findUniqueOrThrow({
        where: { userId_spotifyShowId: { userId, spotifyShowId } },
        select: {
          showName: true,
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          priority: true,
        },
      });
      assert.deepEqual(global, {
        showName: "Cross-source writer fixture",
        cadenceMaxEpisodes: 3,
        cadenceUnit: "MONTH",
        priority: "PRIORITY",
      });

      const legacy = await prisma.podcastShowPolicy.findUniqueOrThrow({
        where: { sourcePlaylistId },
        select: {
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          priority: true,
        },
      });
      assert.deepEqual(legacy, {
        cadenceMaxEpisodes: null,
        cadenceUnit: null,
        priority: "NORMAL",
      });
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "cadence policy can exist for a show discovered through SAVED_EPISODES without a SHOW source",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast06-saved-user-${suffix}`;
    const savedSourceId = `podcast06-saved-source-${suffix}`;
    const spotifyShowId = `saved-show-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.create({
      data: {
        id: savedSourceId,
        userId,
        kind: "PODCAST",
        spotifyType: "SAVED_EPISODES",
        spotifyId: "me",
      },
    });

    try {
      await savePodcastShowCadencePolicy(userId, spotifyShowId, {
        showName: "Saved episodes discovered show",
        cadenceMaxEpisodes: 1,
        cadenceUnit: "WEEK",
        priority: "NORMAL",
      });
      await savePodcastShowCadencePolicy(userId, spotifyShowId, {
        priority: "PRIORITY",
      });

      const policies = await loadPodcastShowCadencePolicies(userId);
      assert.deepEqual(policies.get(spotifyShowId), {
        spotifyShowId,
        showName: "Saved episodes discovered show",
        cadenceMaxEpisodes: 1,
        cadenceUnit: "WEEK",
        priority: "PRIORITY",
      });

      const explicitShowCount = await prisma.sourcePlaylist.count({
        where: { userId, kind: "PODCAST", spotifyType: "SHOW" },
      });
      assert.equal(explicitShowCount, 0);
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);
