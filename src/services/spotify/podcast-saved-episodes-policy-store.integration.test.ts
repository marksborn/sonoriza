import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  loadPodcastSavedEpisodesPolicy,
  PodcastSavedEpisodesPolicyValidationError,
  savePodcastSavedEpisodesPolicy,
} from "./podcast-saved-episodes-policy-store";
import {
  loadPodcastShowPolicies,
  savePodcastShowPolicy,
} from "./podcast-show-policy-store";

const databaseTest = process.env.PODCAST_07_DB_TEST === "1" ? test : test.skip;

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
  "SAVED_EPISODES starts neutral and round-trips explicit PER_SHOW/GLOBAL_POOL policy",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast07-user-${suffix}`;
    const sourcePlaylistId = `podcast07-saved-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.create({
      data: {
        id: sourcePlaylistId,
        userId,
        kind: "PODCAST",
        spotifyType: "SAVED_EPISODES",
        spotifyId: "me",
        name: "Seus episódios",
      },
    });

    try {
      assert.equal(
        await prisma.podcastSavedEpisodesPolicy.count({
          where: { sourcePlaylistId },
        }),
        0,
      );
      assert.equal(
        await loadPodcastSavedEpisodesPolicy(userId, sourcePlaylistId),
        null,
      );

      assert.equal(
        await savePodcastSavedEpisodesPolicy(userId, sourcePlaylistId, {
          enabled: true,
          episodeOrder: "RANDOM",
          randomPolicy: "WITHOUT_REPLACEMENT",
          cadenceMaxEpisodes: 1,
          cadenceUnit: "WEEK",
          frequencyScope: "PER_SHOW",
        }),
        true,
      );

      assert.deepEqual(
        await loadPodcastSavedEpisodesPolicy(userId, sourcePlaylistId),
        {
          sourcePlaylistId,
          enabled: true,
          episodeOrder: "RANDOM",
          randomPolicy: "WITHOUT_REPLACEMENT",
          cadenceMaxEpisodes: 1,
          cadenceUnit: "WEEK",
          frequencyScope: "PER_SHOW",
        },
      );

      assert.equal(
        await savePodcastSavedEpisodesPolicy(userId, sourcePlaylistId, {
          enabled: true,
          episodeOrder: "NEWEST_FIRST",
          randomPolicy: "WITH_REPLACEMENT",
          cadenceMaxEpisodes: 2,
          cadenceUnit: "WEEK",
          frequencyScope: "GLOBAL_POOL",
        }),
        true,
      );

      assert.deepEqual(
        await loadPodcastSavedEpisodesPolicy(userId, sourcePlaylistId),
        {
          sourcePlaylistId,
          enabled: true,
          episodeOrder: "NEWEST_FIRST",
          randomPolicy: "WITH_REPLACEMENT",
          cadenceMaxEpisodes: 2,
          cadenceUnit: "WEEK",
          frequencyScope: "GLOBAL_POOL",
        },
      );
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "SAVED_EPISODES policy validates complete positive weekly cadence",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast07-cadence-user-${suffix}`;
    const sourcePlaylistId = `podcast07-cadence-source-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.create({
      data: {
        id: sourcePlaylistId,
        userId,
        kind: "PODCAST",
        spotifyType: "SAVED_EPISODES",
        spotifyId: "me",
      },
    });

    const base = {
      enabled: true,
      episodeOrder: "RANDOM" as const,
      randomPolicy: "WITHOUT_REPLACEMENT" as const,
      frequencyScope: "PER_SHOW" as const,
    };

    try {
      await assert.rejects(
        savePodcastSavedEpisodesPolicy(userId, sourcePlaylistId, {
          ...base,
          cadenceMaxEpisodes: 1,
          cadenceUnit: null,
        }),
        PodcastSavedEpisodesPolicyValidationError,
      );

      await assert.rejects(
        savePodcastSavedEpisodesPolicy(userId, sourcePlaylistId, {
          ...base,
          cadenceMaxEpisodes: null,
          cadenceUnit: "WEEK",
        }),
        PodcastSavedEpisodesPolicyValidationError,
      );

      await assert.rejects(
        savePodcastSavedEpisodesPolicy(userId, sourcePlaylistId, {
          ...base,
          cadenceMaxEpisodes: 0,
          cadenceUnit: "WEEK",
        }),
        PodcastSavedEpisodesPolicyValidationError,
      );

      assert.equal(
        await prisma.podcastSavedEpisodesPolicy.count({
          where: { sourcePlaylistId },
        }),
        0,
      );
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "SAVED_EPISODES writer rejects SHOW sources and sources owned by another user",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast07-owner-${suffix}`;
    const otherUserId = `podcast07-other-${suffix}`;
    const savedSourceId = `podcast07-owner-saved-${suffix}`;
    const showSourceId = `podcast07-owner-show-${suffix}`;

    await prisma.user.createMany({
      data: [{ id: userId }, { id: otherUserId }],
    });
    await prisma.sourcePlaylist.createMany({
      data: [
        {
          id: savedSourceId,
          userId,
          kind: "PODCAST",
          spotifyType: "SAVED_EPISODES",
          spotifyId: "me",
        },
        {
          id: showSourceId,
          userId,
          kind: "PODCAST",
          spotifyType: "SHOW",
          spotifyId: `show-${suffix}`,
        },
      ],
    });

    const input = {
      enabled: true,
      episodeOrder: "RANDOM" as const,
      randomPolicy: "WITHOUT_REPLACEMENT" as const,
      cadenceMaxEpisodes: 1,
      cadenceUnit: "WEEK" as const,
      frequencyScope: "PER_SHOW" as const,
    };

    try {
      assert.equal(
        await savePodcastSavedEpisodesPolicy(userId, showSourceId, input),
        false,
      );
      assert.equal(
        await savePodcastSavedEpisodesPolicy(otherUserId, savedSourceId, input),
        false,
      );
      assert.equal(await prisma.podcastSavedEpisodesPolicy.count(), 0);
    } finally {
      await prisma.user.deleteMany({
        where: { id: { in: [userId, otherUserId] } },
      });
    }
  },
);

databaseTest(
  "SHOW scope defaults to ALL_EPISODES and legacy saves preserve an explicit SAVED_ONLY override",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast07-show-user-${suffix}`;
    const sourcePlaylistId = `podcast07-show-source-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.create({
      data: {
        id: sourcePlaylistId,
        userId,
        kind: "PODCAST",
        spotifyType: "SHOW",
        spotifyId: `show-${suffix}`,
        name: "PODCAST-07 show scope fixture",
      },
    });

    try {
      assert.equal(
        await savePodcastShowPolicy(userId, sourcePlaylistId, podcast05Input()),
        true,
      );

      let policies = await loadPodcastShowPolicies(userId);
      assert.equal(policies.get(sourcePlaylistId)?.showEpisodeScope, "ALL_EPISODES");

      assert.equal(
        await savePodcastShowPolicy(userId, sourcePlaylistId, {
          ...podcast05Input(),
          showEpisodeScope: "SAVED_ONLY",
        }),
        true,
      );

      policies = await loadPodcastShowPolicies(userId);
      assert.equal(policies.get(sourcePlaylistId)?.showEpisodeScope, "SAVED_ONLY");

      // Existing callers do not know about PODCAST-07 yet. Omitting the new
      // field must not erase an explicit override set by a newer caller.
      assert.equal(
        await savePodcastShowPolicy(userId, sourcePlaylistId, podcast05Input()),
        true,
      );

      policies = await loadPodcastShowPolicies(userId);
      assert.equal(policies.get(sourcePlaylistId)?.showEpisodeScope, "SAVED_ONLY");
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);
