import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  loadPodcastEffectivePolicyShadow,
  type PodcastSavedEpisodeShadowObservation,
} from "./podcast-effective-policy-shadow";
import { savePodcastSavedEpisodesPolicy } from "./podcast-saved-episodes-policy-store";
import { savePodcastShowPolicy } from "./podcast-show-policy-store";

const databaseTest = process.env.PODCAST_07_DB_TEST === "1" ? test : test.skip;

function episode(
  spotifyEpisodeId: string,
  spotifyShowId: string,
  showName: string,
): PodcastSavedEpisodeShadowObservation {
  return {
    spotifyEpisodeId,
    spotifyUri: `spotify:episode:${spotifyEpisodeId}`,
    spotifyShowId,
    showName,
  };
}

function podcast05Input(showEpisodeScope?: "ALL_EPISODES" | "SAVED_ONLY") {
  return {
    episodeEligibility: "UNPLAYED_ONLY" as const,
    episodeOrder: "OLDEST_FIRST" as const,
    randomPolicy: "WITHOUT_REPLACEMENT" as const,
    startEpisodeId: null,
    strictSequence: true,
    maxReleaseAgeDays: null,
    expiryPolicy: "STRICT_EXPIRY" as const,
    maxEpisodesPerCycle: 1,
    ...(showEpisodeScope ? { showEpisodeScope } : {}),
  };
}

databaseTest(
  "Gate 2 joins SAVED_EPISODES default with explicit SHOW authority without materializing legacy policy",
  async () => {
    const suffix = randomUUID();
    const userId = `podcast07-gate2-user-${suffix}`;
    const savedSourceId = `podcast07-gate2-saved-${suffix}`;
    const legacyShowSourceId = `podcast07-gate2-legacy-show-${suffix}`;
    const savedOnlyShowSourceId = `podcast07-gate2-saved-only-show-${suffix}`;
    const legacyShowId = `legacy-show-${suffix}`;
    const savedOnlyShowId = `saved-only-show-${suffix}`;
    const defaultShowId = `default-show-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.createMany({
      data: [
        {
          id: savedSourceId,
          userId,
          kind: "PODCAST",
          spotifyType: "SAVED_EPISODES",
          spotifyId: "me",
          name: "Seus episódios",
        },
        {
          id: legacyShowSourceId,
          userId,
          kind: "PODCAST",
          spotifyType: "SHOW",
          spotifyId: legacyShowId,
          name: "Legacy explicit show",
          includePlayed: true,
          episodeOrder: "NEWEST_FIRST",
        },
        {
          id: savedOnlyShowSourceId,
          userId,
          kind: "PODCAST",
          spotifyType: "SHOW",
          spotifyId: savedOnlyShowId,
          name: "Saved-only explicit show",
        },
      ],
    });

    try {
      assert.equal(
        await savePodcastSavedEpisodesPolicy(userId, savedSourceId, {
          enabled: true,
          episodeOrder: "RANDOM",
          randomPolicy: "WITHOUT_REPLACEMENT",
          cadenceMaxEpisodes: 1,
          cadenceUnit: "WEEK",
          frequencyScope: "PER_SHOW",
        }),
        true,
      );
      assert.equal(
        await savePodcastShowPolicy(
          userId,
          savedOnlyShowSourceId,
          podcast05Input("SAVED_ONLY"),
        ),
        true,
      );

      assert.equal(
        await prisma.podcastShowPolicy.count({
          where: { sourcePlaylistId: legacyShowSourceId },
        }),
        0,
      );

      const result = await loadPodcastEffectivePolicyShadow({
        userId,
        savedEpisodesSourcePlaylistId: savedSourceId,
        savedEpisodes: [
          episode("legacy-episode-1", legacyShowId, "Legacy explicit show"),
          episode("legacy-episode-2", legacyShowId, "Legacy explicit show"),
          episode("saved-only-episode-1", savedOnlyShowId, "Saved-only explicit show"),
          episode("default-episode-1", defaultShowId, "Default governed show"),
        ],
      });

      assert.ok(result);
      const legacyGroup = result.groups.find(
        (group) => group.spotifyShowId === legacyShowId,
      );
      const savedOnlyGroup = result.groups.find(
        (group) => group.spotifyShowId === savedOnlyShowId,
      );
      const defaultGroup = result.groups.find(
        (group) => group.spotifyShowId === defaultShowId,
      );

      assert.equal(legacyGroup?.effectivePolicy.authority, "SHOW_OVERRIDE");
      if (legacyGroup?.effectivePolicy.authority === "SHOW_OVERRIDE") {
        assert.equal(legacyGroup.effectivePolicy.showEpisodeScope, "ALL_EPISODES");
        assert.equal(legacyGroup.effectivePolicy.policy.episodeEligibility, "ALL");
        assert.equal(legacyGroup.effectivePolicy.policy.episodeOrder, "NEWEST_FIRST");
        assert.equal(legacyGroup.effectivePolicy.policy.cadenceMaxEpisodes, null);
      }

      assert.equal(savedOnlyGroup?.effectivePolicy.authority, "SHOW_OVERRIDE");
      if (savedOnlyGroup?.effectivePolicy.authority === "SHOW_OVERRIDE") {
        assert.equal(savedOnlyGroup.effectivePolicy.showEpisodeScope, "SAVED_ONLY");
      }

      assert.equal(
        defaultGroup?.effectivePolicy.authority,
        "SAVED_EPISODES_DEFAULT",
      );
      if (defaultGroup?.effectivePolicy.authority === "SAVED_EPISODES_DEFAULT") {
        assert.equal(defaultGroup.effectivePolicy.policy.frequencyScope, "PER_SHOW");
        assert.equal(defaultGroup.effectivePolicy.policy.cadenceMaxEpisodes, 1);
      }

      assert.deepEqual(result.diagnostics, {
        savedEpisodeCount: 4,
        groupedSavedEpisodeCount: 4,
        missingShowIdentityCount: 0,
        observedShowCount: 3,
        showOverrideCount: 2,
        savedOnlyOverrideShowCount: 1,
        allEpisodesOverrideShowCount: 1,
        defaultGovernedShowCount: 1,
        legacySavedEpisodesShowCount: 0,
        shadowSuppressedSavedEpisodeCount: 3,
      });

      // Gate 2 is read-only: resolving a legacy SHOW must not create a policy row.
      assert.equal(
        await prisma.podcastShowPolicy.count({
          where: { sourcePlaylistId: legacyShowSourceId },
        }),
        0,
      );
    } finally {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  },
);

databaseTest(
  "Gate 2 rejects an unrelated SAVED_EPISODES source instead of resolving cross-user state",
  async () => {
    const suffix = randomUUID();
    const ownerId = `podcast07-gate2-owner-${suffix}`;
    const otherUserId = `podcast07-gate2-other-${suffix}`;
    const sourcePlaylistId = `podcast07-gate2-owner-source-${suffix}`;

    await prisma.user.createMany({ data: [{ id: ownerId }, { id: otherUserId }] });
    await prisma.sourcePlaylist.create({
      data: {
        id: sourcePlaylistId,
        userId: ownerId,
        kind: "PODCAST",
        spotifyType: "SAVED_EPISODES",
        spotifyId: "me",
      },
    });

    try {
      assert.equal(
        await loadPodcastEffectivePolicyShadow({
          userId: otherUserId,
          savedEpisodesSourcePlaylistId: sourcePlaylistId,
          savedEpisodes: [],
        }),
        null,
      );
    } finally {
      await prisma.user.deleteMany({
        where: { id: { in: [ownerId, otherUserId] } },
      });
    }
  },
);
