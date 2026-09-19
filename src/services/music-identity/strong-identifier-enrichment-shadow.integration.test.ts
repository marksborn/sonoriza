import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";
import { runMusicIdentityStrongIdentifierShadow } from "./strong-identifier-enrichment-shadow";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

databaseTest("Gate 3B enriches strong IDs through an injected provider and leaves canonical identities unchanged", async () => {
  const suffix = randomUUID();
  const userId = `identity-gate3b-${suffix}`;

  await prisma.user.create({ data: { id: userId } });

  try {
    const artist = await prisma.artistIdentity.create({
      data: {
        userId,
        canonicalName: "Gate 3B Artist",
      },
    });
    await prisma.artistProviderRef.create({
      data: {
        userId,
        artistIdentityId: artist.id,
        provider: "spotify",
        providerScope: "global",
        providerArtistId: "gate3b-artist",
        matchReason: "SINGLETON_BOOTSTRAP",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

    const tracks = [
      {
        id: "gate3b-standard",
        title: "Gate 3B Song",
        albumId: "gate3b-album-standard",
        albumName: "Gate 3B Album",
        durationMs: 180_000,
      },
      {
        id: "gate3b-remaster",
        title: "Gate 3B Song - 2021 Remaster",
        albumId: "gate3b-album-remaster",
        albumName: "Gate 3B Album - 2021 Remaster",
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
        spotifyId: "gate3b-source",
        name: "Gate 3B Source",
        cachedCandidates: {
          version: 5,
          unavailableTrackCount: 0,
          candidates: tracks.map((track) => ({
            uri: `spotify:track:${track.id}`,
            spotifyTrackId: track.id,
            title: track.title,
            subtitle: "Gate 3B Artist",
            primaryArtistId: "gate3b-artist",
            primaryArtistName: "Gate 3B Artist",
            albumId: track.albumId,
            albumName: track.albumName,
            durationMs: track.durationMs,
          })),
        } as Prisma.InputJsonValue,
        spotifySnapshotId: "gate3b-snapshot",
        cacheUpdatedAt: new Date("2026-09-19T23:30:00.000Z"),
      },
    });

    await prisma.targetPlaylist.create({
      data: {
        userId,
        name: "Gate 3B Target",
        sequencePattern: [] as Prisma.InputJsonValue,
      },
    });

    const before = {
      artists: await prisma.artistIdentity.count({ where: { userId } }),
      songs: await prisma.songIdentity.count({ where: { userId } }),
      recordings: await prisma.recordingIdentity.count({ where: { userId } }),
      refs: await prisma.trackProviderRef.count({ where: { userId } }),
    };

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
            isrc: "USGATE3260001",
            artists: [
              {
                id: "gate3b-artist",
                name: "Gate 3B Artist",
                uri: "spotify:artist:gate3b-artist",
                spotifyUrl: null,
              },
            ],
            albumId: null,
            albumName: null,
            durationMs: id === "gate3b-standard" ? 180_000 : 181_000,
            linkedFromTrackId: null,
            isPlayable: true,
            restrictionReason: null,
          },
        }));
      },
      getMetrics() {
        return { totalCalls: 1 };
      },
    };

    const report = await runMusicIdentityStrongIdentifierShadow(userId, {
      provider,
    });

    assert.equal(report.mode, "SHADOW_PROVIDER_ENRICHMENT_READ_ONLY");
    if (report.mode !== "SHADOW_PROVIDER_ENRICHMENT_READ_ONLY") {
      assert.fail(`unexpected abstention: ${report.abstentionReason}`);
    }

    assert.equal(report.authority.providerCalls, true);
    assert.equal(report.authority.identityWrites, false);
    assert.equal(report.baseline.textualPossibleMatchPairs, 1);
    assert.equal(report.baseline.sameSongDifferentRecordingPairs, 0);
    assert.equal(report.baseline.reconstructedTextualPairs, 1);
    assert.equal(report.provider.requestedDistinctTracks, 2);
    assert.equal(report.provider.tracksWithIsrc, 2);
    assert.equal(report.resolution.pairCount, 1);
    assert.equal(report.resolution.sameIsrcPairs, 1);
    assert.equal(report.resolution.upgradedToRecordingReviewPairs, 1);
    assert.deepEqual(requestedIds, [["gate3b-remaster", "gate3b-standard"]]);

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
