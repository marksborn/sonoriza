import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  loadEffectivePlaybackReservePolicy,
  loadPlaybackReservePolicy,
  loadTargetPlaybackReservePolicy,
  savePlaybackReservePolicy,
  saveTargetPlaybackReservePolicy,
} from "./playback-reserve-policy";

const databaseTest = process.env.PLAYBACK_RESERVE_DB_TEST === "1" ? test : test.skip;

databaseTest(
  "missing rows preserve NONE globally and INHERIT_GLOBAL per target",
  async () => {
    const suffix = randomUUID();
    const userId = `reserve-user-${suffix}`;
    const targetPlaylistId = `reserve-target-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "PLAYBACK-RESERVE-01 integration fixture",
        fixedDurationSeconds: 3600,
        sequencePattern: ["MUSIC"],
      },
    });

    try {
      assert.deepEqual(await loadPlaybackReservePolicy(userId), {
        reserveMode: "NONE",
        durationSeconds: null,
        musicTrackCount: null,
        podcastEpisodeCount: null,
        podcastInDurationReserve: "DISABLED",
      });

      assert.deepEqual(
        await loadTargetPlaybackReservePolicy(userId, targetPlaylistId),
        {
          targetPlaylistId,
          policyMode: "INHERIT_GLOBAL",
          reserveMode: null,
          durationSeconds: null,
          musicTrackCount: null,
          podcastEpisodeCount: null,
          podcastInDurationReserve: null,
        },
      );

      assert.equal(
        await prisma.playbackReservePolicy.count({ where: { userId } }),
        0,
      );
      assert.equal(
        await prisma.targetPlaybackReservePolicy.count({
          where: { userId, targetPlaylistId },
        }),
        0,
      );
    } finally {
      await cleanup(userId, targetPlaylistId);
    }
  },
);

databaseTest(
  "global policy persists and target override NONE disables it effectively",
  async () => {
    const suffix = randomUUID();
    const userId = `reserve-global-user-${suffix}`;
    const targetPlaylistId = `reserve-global-target-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "PLAYBACK-RESERVE-01 override fixture",
        fixedDurationSeconds: 3600,
        sequencePattern: ["MUSIC", "PODCAST"],
      },
    });

    try {
      await savePlaybackReservePolicy(userId, {
        reserveMode: "DURATION",
        durationSeconds: 900,
        podcastInDurationReserve: "IF_FITS",
      });

      assert.deepEqual(
        await loadEffectivePlaybackReservePolicy(userId, targetPlaylistId),
        {
          targetPlaylistId,
          source: "GLOBAL",
          reserveMode: "DURATION",
          durationSeconds: 900,
          musicTrackCount: null,
          podcastEpisodeCount: null,
          podcastInDurationReserve: "IF_FITS",
        },
      );

      await saveTargetPlaybackReservePolicy(userId, targetPlaylistId, {
        policyMode: "OVERRIDE",
        reserveMode: "NONE",
      });

      assert.deepEqual(
        await loadEffectivePlaybackReservePolicy(userId, targetPlaylistId),
        {
          targetPlaylistId,
          source: "TARGET_OVERRIDE",
          reserveMode: "NONE",
          durationSeconds: null,
          musicTrackCount: null,
          podcastEpisodeCount: null,
          podcastInDurationReserve: "DISABLED",
        },
      );
    } finally {
      await cleanup(userId, targetPlaylistId);
    }
  },
);

databaseTest(
  "target store refuses policy writes for a target owned by another user",
  async () => {
    const suffix = randomUUID();
    const ownerId = `reserve-owner-${suffix}`;
    const otherUserId = `reserve-other-${suffix}`;
    const targetPlaylistId = `reserve-owned-target-${suffix}`;

    await prisma.user.createMany({
      data: [{ id: ownerId }, { id: otherUserId }],
    });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId: ownerId,
        name: "PLAYBACK-RESERVE-01 ownership fixture",
        fixedDurationSeconds: 3600,
        sequencePattern: ["MUSIC"],
      },
    });

    try {
      await assert.rejects(
        () =>
          saveTargetPlaybackReservePolicy(otherUserId, targetPlaylistId, {
            policyMode: "OVERRIDE",
            reserveMode: "MUSIC_TRACKS",
            musicTrackCount: 5,
          }),
        /does not belong to the user/,
      );

      assert.equal(
        await prisma.targetPlaybackReservePolicy.count({
          where: { targetPlaylistId },
        }),
        0,
      );
    } finally {
      await prisma.targetPlaybackReservePolicy
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
  "database constraints reject invalid mode/field combinations when contract is bypassed",
  async () => {
    const suffix = randomUUID();
    const userId = `reserve-check-user-${suffix}`;
    const targetPlaylistId = `reserve-check-target-${suffix}`;

    await prisma.user.create({ data: { id: userId } });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "PLAYBACK-RESERVE-01 constraint fixture",
        fixedDurationSeconds: 3600,
        sequencePattern: ["MUSIC"],
      },
    });

    try {
      await assert.rejects(() =>
        prisma.playbackReservePolicy.create({
          data: {
            userId,
            reserveMode: "DURATION",
            durationSeconds: null,
            musicTrackCount: null,
            podcastEpisodeCount: null,
            podcastInDurationReserve: "DISABLED",
          },
        }),
      );

      await assert.rejects(() =>
        prisma.playbackReservePolicy.create({
          data: {
            userId,
            reserveMode: "MUSIC_TRACKS",
            durationSeconds: 900,
            musicTrackCount: 5,
            podcastInDurationReserve: "DISABLED",
          },
        }),
      );

      await assert.rejects(() =>
        prisma.targetPlaybackReservePolicy.create({
          data: {
            userId,
            targetPlaylistId,
            policyMode: "OVERRIDE",
            reserveMode: "DURATION",
            durationSeconds: null,
            musicTrackCount: null,
            podcastEpisodeCount: null,
            podcastInDurationReserve: "DISABLED",
          },
        }),
      );

      await assert.rejects(() =>
        prisma.targetPlaybackReservePolicy.create({
          data: {
            userId,
            targetPlaylistId,
            policyMode: "OVERRIDE",
            reserveMode: "DURATION",
            durationSeconds: 900,
            musicTrackCount: null,
            podcastEpisodeCount: null,
            podcastInDurationReserve: null,
          },
        }),
      );
    } finally {
      await cleanup(userId, targetPlaylistId);
    }
  },
);

async function cleanup(userId: string, targetPlaylistId: string) {
  await prisma.targetPlaybackReservePolicy
    .deleteMany({ where: { userId, targetPlaylistId } })
    .catch(() => undefined);
  await prisma.playbackReservePolicy
    .deleteMany({ where: { userId } })
    .catch(() => undefined);
  await prisma.targetPlaylist
    .delete({ where: { id: targetPlaylistId } })
    .catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}
