import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { runMusicIdentityShadowResolverReport } from "./shadow-resolver-report";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

databaseTest("Gate 3 reads the persisted graph/cache in a read-only transaction and leaves identities unchanged", async () => {
  const suffix = randomUUID();
  const userId = `identity-gate3-${suffix}`;

  await prisma.user.create({ data: { id: userId } });

  try {
    const artist = await prisma.artistIdentity.create({
      data: {
        userId,
        canonicalName: "Gate 3 Artist",
      },
    });
    await prisma.artistProviderRef.create({
      data: {
        userId,
        artistIdentityId: artist.id,
        provider: "spotify",
        providerScope: "global",
        providerArtistId: "gate3-artist",
        matchReason: "SINGLETON_BOOTSTRAP",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

    for (const track of [
      {
        id: "gate3-standard",
        title: "Gate 3 Song",
        albumId: "gate3-album-standard",
        albumName: "Gate 3 Album",
        durationMs: 180_000,
      },
      {
        id: "gate3-live",
        title: "Gate 3 Song - Live at Test Hall",
        albumId: "gate3-album-live",
        albumName: "Live at Test Hall",
        durationMs: 230_000,
      },
    ]) {
      const song = await prisma.songIdentity.create({
        data: {
          userId,
          primaryArtistIdentityId: artist.id,
          canonicalTitle: track.title,
        },
      });
      const recording = await prisma.recordingIdentity.create({
        data: {
          userId,
          songIdentityId: song.id,
        },
      });
      await prisma.trackProviderRef.create({
        data: {
          userId,
          recordingIdentityId: recording.id,
          provider: "spotify",
          providerScope: "global",
          providerTrackId: track.id,
          uri: `spotify:track:${track.id}`,
          executionStatus: "KNOWN",
          matchReason: "SINGLETON_BOOTSTRAP",
          confidenceBasisPoints: 10_000,
          resolutionLineage: { origins: ["SPOTIFY"] },
        },
      });
    }

    await prisma.sourcePlaylist.create({
      data: {
        userId,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "gate3-source",
        name: "Gate 3 Source",
        cachedCandidates: {
          version: 5,
          unavailableTrackCount: 0,
          candidates: [
            {
              uri: "spotify:track:gate3-standard",
              spotifyTrackId: "gate3-standard",
              title: "Gate 3 Song",
              subtitle: "Gate 3 Artist",
              primaryArtistId: "gate3-artist",
              primaryArtistName: "Gate 3 Artist",
              albumId: "gate3-album-standard",
              albumName: "Gate 3 Album",
              durationMs: 180_000,
            },
            {
              uri: "spotify:track:gate3-live",
              spotifyTrackId: "gate3-live",
              title: "Gate 3 Song - Live at Test Hall",
              subtitle: "Gate 3 Artist",
              primaryArtistId: "gate3-artist",
              primaryArtistName: "Gate 3 Artist",
              albumId: "gate3-album-live",
              albumName: "Live at Test Hall",
              durationMs: 230_000,
            },
          ],
        } as Prisma.InputJsonValue,
        spotifySnapshotId: "gate3-snapshot",
        cacheUpdatedAt: new Date("2026-09-19T23:00:00.000Z"),
      },
    });
    await prisma.targetPlaylist.create({
      data: {
        userId,
        name: "Gate 3 Target",
        sequencePattern: [] as Prisma.InputJsonValue,
      },
    });

    const before = {
      artists: await prisma.artistIdentity.count({ where: { userId } }),
      songs: await prisma.songIdentity.count({ where: { userId } }),
      recordings: await prisma.recordingIdentity.count({ where: { userId } }),
      refs: await prisma.trackProviderRef.count({ where: { userId } }),
    };

    const report = await runMusicIdentityShadowResolverReport(userId);

    assert.equal(report.mode, "SHADOW_READ_ONLY");
    assert.equal(report.authority.providerCalls, false);
    assert.equal(report.authority.writes, false);
    assert.equal(report.authority.interpretation, "COMPLETE_PERSISTED_SNAPSHOT");
    assert.equal(report.scope.reachableMusicSources, 1);
    assert.equal(report.cache.fullValidSources, 1);
    assert.equal(report.cache.distinctSpotifyTracks, 2);
    assert.equal(report.canonical.trackProviderRefs, 2);
    assert.equal(report.canonical.cacheEnrichedTrackProviderRefs, 2);
    assert.equal(report.resolution.sameSongDifferentRecordingPairs, 1);
    assert.equal(report.resolution.pairs[0]?.resolution.reason, "SAME_SONG_DIFFERENT_RECORDING");
    assert.equal(report.resolution.pairs[0]?.resolution.action, "KEEP_RECORDINGS_SEPARATE");

    const after = {
      artists: await prisma.artistIdentity.count({ where: { userId } }),
      songs: await prisma.songIdentity.count({ where: { userId } }),
      recordings: await prisma.recordingIdentity.count({ where: { userId } }),
      refs: await prisma.trackProviderRef.count({ where: { userId } }),
    };
    assert.deepEqual(after, before);
  } finally {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});
