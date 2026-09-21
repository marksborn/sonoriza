import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";
import { runMusicIdentityCanonicalConsumerDedupeShadow } from "./canonical-consumer-dedupe-shadow";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

databaseTest("Gate 4C reports a real consumer collision and leaves persisted state unchanged", async () => {
  const suffix = randomUUID();
  const userId = `identity-gate4c-${suffix}`;

  await prisma.user.create({ data: { id: userId } });

  try {
    const artist = await prisma.artistIdentity.create({
      data: { userId, canonicalName: "Gate 4C Artist" },
    });
    await prisma.artistProviderRef.create({
      data: {
        userId,
        artistIdentityId: artist.id,
        provider: "spotify",
        providerScope: "global",
        providerArtistId: "gate4c-artist",
        matchReason: "SINGLETON_BOOTSTRAP",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

    const tracks = [
      {
        id: "gate4c-standard",
        title: "Gate 4C Song",
        albumId: "gate4c-album-standard",
        albumName: "Gate 4C Album",
        durationMs: 180_000,
      },
      {
        id: "gate4c-remaster",
        title: "Gate 4C Song - 2021 Remaster",
        albumId: "gate4c-album-remaster",
        albumName: "Gate 4C Album - 2021 Remaster",
        durationMs: 181_000,
      },
    ];

    for (const track of tracks) {
      const song = await prisma.songIdentity.create({
        data: {
          userId,
          primaryArtistIdentityId: artist.id,
          canonicalTitle: track.title,
        },
      });
      const recording = await prisma.recordingIdentity.create({
        data: { userId, songIdentityId: song.id },
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

    const source = await prisma.sourcePlaylist.create({
      data: {
        userId,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "gate4c-source",
        name: "Gate 4C Source",
        cachedCandidates: {
          version: 5,
          unavailableTrackCount: 0,
          candidates: tracks.map((track) => ({
            uri: `spotify:track:${track.id}`,
            spotifyTrackId: track.id,
            title: track.title,
            subtitle: "Gate 4C Artist",
            primaryArtistId: "gate4c-artist",
            primaryArtistName: "Gate 4C Artist",
            albumId: track.albumId,
            albumName: track.albumName,
            durationMs: track.durationMs,
          })),
        } as Prisma.InputJsonValue,
        spotifySnapshotId: "gate4c-snapshot",
        cacheUpdatedAt: new Date("2026-09-21T12:00:00.000Z"),
      },
    });

    const target = await prisma.targetPlaylist.create({
      data: {
        userId,
        name: "Gate 4C Target",
        sequencePattern: [] as Prisma.InputJsonValue,
      },
    });

    const before = await snapshot(userId, source.id);
    const requestedIds: string[][] = [];
    const provider = {
      async lookupTracksByIds(trackIds: readonly string[]): Promise<SpotifyCatalogTrackLookup[]> {
        requestedIds.push([...trackIds]);
        return trackIds.map((id) => ({
          requestedTrackId: id,
          track: {
            id,
            name: id,
            uri: `spotify:track:${id}`,
            spotifyUrl: null,
            isrc: "USGATE4C00001",
            artists: [
              {
                id: "gate4c-artist",
                name: "Gate 4C Artist",
                uri: "spotify:artist:gate4c-artist",
                spotifyUrl: null,
              },
            ],
            albumId: null,
            albumName: null,
            durationMs: id === "gate4c-standard" ? 180_000 : 181_000,
            linkedFromTrackId: null,
            isPlayable: true,
            restrictionReason: null,
          },
        }));
      },
      getMetrics() {
        return { totalCalls: 2, failures: 0 };
      },
    };

    const report = await runMusicIdentityCanonicalConsumerDedupeShadow(userId, {
      provider,
    });

    if (report.mode !== "SHADOW_CANONICAL_CONSUMER_DEDUPE_READ_ONLY") {
      assert.fail(`unexpected abstention: ${report.abstentionReason}`);
    }

    assert.equal(report.authority.identityWrites, false);
    assert.equal(report.authority.canonicalWrites, false);
    assert.equal(report.authority.preferenceWrites, false);
    assert.equal(report.authority.preferencePropagation, false);
    assert.equal(report.authority.sourceCacheWrites, false);
    assert.equal(report.authority.consumerActivation, false);
    assert.equal(report.authority.plannerInfluence, false);
    assert.equal(report.authority.spotifyPlaylistWrites, false);
    assert.equal(report.authority.orderHashInfluence, false);
    assert.equal(report.authority.representativeSelection, false);
    assert.equal(report.baseline.reconstructedTextualPairs, 1);
    assert.equal(report.provider.requestedDistinctTracks, 2);
    assert.equal(report.components.safeComponents, 1);
    assert.equal(report.components.blockedComponents, 0);
    assert.equal(report.legacyInput.enabledTargets, 1);
    assert.equal(report.legacyInput.reachableMusicSources, 1);
    assert.equal(report.legacyInput.distinctProviderTrackIds, 2);
    assert.equal(report.comparison.targetsWithCanonicalCollision, 1);
    assert.equal(report.comparison.sourcesWithCanonicalCollision, 1);
    assert.equal(report.comparison.targetHypotheticalReduction, 1);
    assert.equal(report.comparison.sourceHypotheticalReduction, 1);

    const targetProjection = report.comparison.targets.find(
      (row) => row.targetPlaylistId === target.id,
    );
    assert.ok(targetProjection);
    assert.equal(targetProjection.collisionComponents, 1);
    assert.equal(targetProjection.hypotheticalReduction, 1);
    assert.equal(targetProjection.collisionSamples[0]?.representativeProviderTrackId, null);
    assert.deepEqual(requestedIds, [["gate4c-remaster", "gate4c-standard"]]);

    const after = await snapshot(userId, source.id);
    assert.deepEqual(after, before);
  } finally {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

async function snapshot(userId: string, sourceId: string) {
  const source = await prisma.sourcePlaylist.findUnique({
    where: { id: sourceId },
    select: { cachedCandidates: true, cacheUpdatedAt: true },
  });
  return {
    artists: await prisma.artistIdentity.count({ where: { userId } }),
    songs: await prisma.songIdentity.count({ where: { userId } }),
    recordings: await prisma.recordingIdentity.count({ where: { userId } }),
    refs: await prisma.trackProviderRef.count({ where: { userId } }),
    preferences: await prisma.firstPartyPlaybackPreference.count({ where: { userId } }),
    source,
  };
}
