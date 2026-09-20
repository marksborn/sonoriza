import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";
import { runMusicIdentityDurationEvidenceShadow } from "./duration-evidence-shadow";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

databaseTest("Gate 3C distinguishes missing persisted duration from compatible provider duration without canonical writes", async () => {
  const suffix = randomUUID();
  const userId = `identity-gate3c-${suffix}`;

  await prisma.user.create({ data: { id: userId } });

  try {
    const artist = await prisma.artistIdentity.create({
      data: {
        userId,
        canonicalName: "Gate 3C Artist",
      },
    });
    await prisma.artistProviderRef.create({
      data: {
        userId,
        artistIdentityId: artist.id,
        provider: "spotify",
        providerScope: "global",
        providerArtistId: "gate3c-artist",
        matchReason: "SINGLETON_BOOTSTRAP",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

    const tracks = [
      {
        id: "gate3c-standard",
        title: "Gate 3C Song",
        albumId: "gate3c-album-standard",
        albumName: "Gate 3C Album",
        persistedDurationMs: 0,
        providerDurationMs: 180_000,
      },
      {
        id: "gate3c-remaster",
        title: "Gate 3C Song - 2021 Remaster",
        albumId: "gate3c-album-remaster",
        albumName: "Gate 3C Album - 2021 Remaster",
        persistedDurationMs: 181_000,
        providerDurationMs: 181_000,
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
        spotifyId: "gate3c-source",
        name: "Gate 3C Source",
        cachedCandidates: {
          version: 5,
          unavailableTrackCount: 0,
          candidates: tracks.map((track) => ({
            uri: `spotify:track:${track.id}`,
            spotifyTrackId: track.id,
            title: track.title,
            subtitle: "Gate 3C Artist",
            primaryArtistId: "gate3c-artist",
            primaryArtistName: "Gate 3C Artist",
            albumId: track.albumId,
            albumName: track.albumName,
            durationMs: track.persistedDurationMs,
          })),
        } as Prisma.InputJsonValue,
        spotifySnapshotId: "gate3c-snapshot",
        cacheUpdatedAt: new Date("2026-09-20T00:50:00.000Z"),
      },
    });

    await prisma.targetPlaylist.create({
      data: {
        userId,
        name: "Gate 3C Target",
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
        return trackIds.map((id) => {
          const track = tracks.find((candidate) => candidate.id === id);
          assert.ok(track);
          return {
            requestedTrackId: id,
            track: {
              id,
              name: track.title,
              uri: `spotify:track:${id}`,
              spotifyUrl: null,
              isrc: "USGATE3260002",
              artists: [
                {
                  id: "gate3c-artist",
                  name: "Gate 3C Artist",
                  uri: "spotify:artist:gate3c-artist",
                  spotifyUrl: null,
                },
              ],
              albumId: track.albumId,
              albumName: track.albumName,
              durationMs: track.providerDurationMs,
              linkedFromTrackId: null,
              isPlayable: true,
              restrictionReason: null,
            },
          };
        });
      },
      getMetrics() {
        return { totalCalls: 2, failures: 0 };
      },
    };

    const report = await runMusicIdentityDurationEvidenceShadow(userId, {
      provider,
    });

    if (report.mode !== "SHADOW_DURATION_EVIDENCE_READ_ONLY") {
      assert.fail(`unexpected abstention: ${report.abstentionReason}`);
    }

    assert.equal(report.authority.providerCalls, true);
    assert.equal(report.authority.canonicalWrites, false);
    assert.equal(report.baseline.reconstructedTextualPairs, 1);
    assert.equal(report.provider.requestedDistinctTracks, 2);
    assert.equal(report.provider.tracksWithDuration, 2);
    assert.equal(report.diagnostics.sameIsrcPairs, 1);
    assert.equal(report.diagnostics.persistedDurationMissingPairs, 1);
    assert.equal(report.diagnostics.providerDurationCompletePairs, 1);
    assert.equal(report.diagnostics.providerStrongConflictPairs, 0);
    assert.equal(report.diagnostics.persistedMissingButProviderCompatiblePairs, 1);
    assert.equal(report.diagnostics.samples.length, 1);
    assert.equal(report.diagnostics.samples[0]?.persistedDurationAvailability, "RIGHT_MISSING");
    assert.equal(report.diagnostics.samples[0]?.providerDurationDeltaMs, 1_000);
    assert.deepEqual(requestedIds, [["gate3c-remaster", "gate3c-standard"]]);

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
