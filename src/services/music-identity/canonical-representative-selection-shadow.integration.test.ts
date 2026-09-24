import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";
import { runMusicIdentityCanonicalConsumerDedupeShadow } from "./canonical-consumer-dedupe-shadow";
import { runMusicIdentityCanonicalRepresentativeSelectionShadow } from "./canonical-representative-selection-shadow";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

databaseTest("Gate 4D selects the legacy first occurrence and leaves persisted state unchanged", async () => {
  const suffix = randomUUID();
  const userId = `identity-gate4d-${suffix}`;

  await prisma.user.create({ data: { id: userId } });

  try {
    const artist = await prisma.artistIdentity.create({
      data: { userId, canonicalName: "Gate 4D Artist" },
    });
    await prisma.artistProviderRef.create({
      data: {
        userId,
        artistIdentityId: artist.id,
        provider: "spotify",
        providerScope: "global",
        providerArtistId: "gate4d-artist",
        matchReason: "SINGLETON_BOOTSTRAP",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

    const tracks = [
      {
        id: "gate4d-remaster",
        title: "Gate 4D Song - 2021 Remaster",
        albumId: "gate4d-album-remaster",
        albumName: "Gate 4D Album - 2021 Remaster",
        durationMs: 181_000,
      },
      {
        id: "gate4d-standard",
        title: "Gate 4D Song",
        albumId: "gate4d-album-standard",
        albumName: "Gate 4D Album",
        durationMs: 180_000,
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
        spotifyId: "gate4d-source",
        name: "Gate 4D Source",
        cachedCandidates: {
          version: 5,
          unavailableTrackCount: 0,
          candidates: tracks.map((track) => ({
            uri: `spotify:track:${track.id}`,
            spotifyTrackId: track.id,
            title: track.title,
            subtitle: "Gate 4D Artist",
            primaryArtistId: "gate4d-artist",
            primaryArtistName: "Gate 4D Artist",
            albumId: track.albumId,
            albumName: track.albumName,
            durationMs: track.durationMs,
          })),
        } as Prisma.InputJsonValue,
        spotifySnapshotId: "gate4d-snapshot",
        cacheUpdatedAt: new Date("2026-09-24T00:00:00.000Z"),
      },
    });

    const target = await prisma.targetPlaylist.create({
      data: {
        userId,
        name: "Gate 4D Target",
        sequencePattern: [] as Prisma.InputJsonValue,
      },
    });

    const before = await snapshot(userId, source.id);
    const provider = {
      async lookupTracksByIds(trackIds: readonly string[]): Promise<SpotifyCatalogTrackLookup[]> {
        return trackIds.map((id) => ({
          requestedTrackId: id,
          track: {
            id,
            name: id,
            uri: `spotify:track:${id}`,
            spotifyUrl: null,
            isrc: "USGATE4D00001",
            artists: [
              {
                id: "gate4d-artist",
                name: "Gate 4D Artist",
                uri: "spotify:artist:gate4d-artist",
                spotifyUrl: null,
              },
            ],
            albumId: null,
            albumName: null,
            durationMs: id === "gate4d-standard" ? 180_000 : 181_000,
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

    const report = await runMusicIdentityCanonicalRepresentativeSelectionShadow(userId, {
      gate4cRunner: (id) =>
        runMusicIdentityCanonicalConsumerDedupeShadow(id, { provider }),
    });

    if (report.mode !== "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_READ_ONLY") {
      assert.fail(`unexpected abstention: ${report.abstentionReason} ${report.detail ?? ""}`);
    }

    assert.equal(report.authority.identityWrites, false);
    assert.equal(report.authority.canonicalWrites, false);
    assert.equal(report.authority.providerRefReassociation, false);
    assert.equal(report.authority.preferenceWrites, false);
    assert.equal(report.authority.preferencePropagation, false);
    assert.equal(report.authority.sourceCacheWrites, false);
    assert.equal(report.authority.consumerActivation, false);
    assert.equal(report.authority.plannerInfluence, false);
    assert.equal(report.authority.spotifyPlaylistWrites, false);
    assert.equal(report.authority.orderHashInfluence, false);
    assert.equal(report.authority.productiveRepresentativeSelection, false);
    assert.equal(report.selection.collisionsReceived, 1);
    assert.equal(report.selection.collisionsSelectable, 1);
    assert.equal(report.selection.collisionsAbstained, 0);
    assert.equal(report.selection.hypotheticalDrops, 1);
    assert.equal(report.selection.gate4cExpectedHypotheticalDrops, 1);
    assert.equal(report.selection.reductionReconciled, true);
    assert.equal(report.orderingProof.postSelectionFingerprintMatched, true);

    const targetResult = report.selection.targets.find(
      (row) => row.targetPlaylistId === target.id,
    );
    assert.ok(targetResult);
    assert.equal(targetResult.selections.length, 1);
    const selection = targetResult.selections[0]!;
    assert.equal(selection.representativeProviderTrackId, "gate4d-remaster");
    assert.deepEqual(selection.droppedProviderTrackIds, ["gate4d-standard"]);
    assert.equal(selection.decisiveCriterion, "CACHE_POSITION");
    assert.equal(selection.representativeOccurrence.cachePosition, 0);

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
