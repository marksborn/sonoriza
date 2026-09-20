import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";
import { runMusicIdentityCanonicalComponentClosureShadow } from "./canonical-component-closure-shadow";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

databaseTest("Gate 4B builds a safe component and leaves persisted state unchanged", async () => {
  const suffix = randomUUID();
  const userId = `identity-gate4b-${suffix}`;

  await prisma.user.create({ data: { id: userId } });

  try {
    const artist = await prisma.artistIdentity.create({
      data: { userId, canonicalName: "Gate 4B Artist" },
    });
    await prisma.artistProviderRef.create({
      data: {
        userId,
        artistIdentityId: artist.id,
        provider: "spotify",
        providerScope: "global",
        providerArtistId: "gate4b-artist",
        matchReason: "SINGLETON_BOOTSTRAP",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

    const tracks = [
      {
        id: "gate4b-standard",
        title: "Gate 4B Song",
        albumId: "gate4b-album-standard",
        albumName: "Gate 4B Album",
        durationMs: 180_000,
      },
      {
        id: "gate4b-remaster",
        title: "Gate 4B Song - 2021 Remaster",
        albumId: "gate4b-album-remaster",
        albumName: "Gate 4B Album - 2021 Remaster",
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

    await prisma.sourcePlaylist.create({
      data: {
        userId,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "gate4b-source",
        name: "Gate 4B Source",
        cachedCandidates: {
          version: 5,
          unavailableTrackCount: 0,
          candidates: tracks.map((track) => ({
            uri: `spotify:track:${track.id}`,
            spotifyTrackId: track.id,
            title: track.title,
            subtitle: "Gate 4B Artist",
            primaryArtistId: "gate4b-artist",
            primaryArtistName: "Gate 4B Artist",
            albumId: track.albumId,
            albumName: track.albumName,
            durationMs: track.durationMs,
          })),
        } as Prisma.InputJsonValue,
        spotifySnapshotId: "gate4b-snapshot",
        cacheUpdatedAt: new Date("2026-09-20T15:00:00.000Z"),
      },
    });

    await prisma.targetPlaylist.create({
      data: {
        userId,
        name: "Gate 4B Target",
        sequencePattern: [] as Prisma.InputJsonValue,
      },
    });

    const before = await snapshot(userId);
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
            isrc: "USGATE4B00001",
            artists: [
              {
                id: "gate4b-artist",
                name: "Gate 4B Artist",
                uri: "spotify:artist:gate4b-artist",
                spotifyUrl: null,
              },
            ],
            albumId: null,
            albumName: null,
            durationMs: id === "gate4b-standard" ? 180_000 : 181_000,
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

    const report = await runMusicIdentityCanonicalComponentClosureShadow(userId, {
      provider,
    });

    if (report.mode !== "SHADOW_CANONICAL_COMPONENT_CLOSURE_READ_ONLY") {
      assert.fail(`unexpected abstention: ${report.abstentionReason}`);
    }

    assert.equal(report.authority.identityWrites, false);
    assert.equal(report.authority.canonicalWrites, false);
    assert.equal(report.authority.preferenceWrites, false);
    assert.equal(report.authority.consumerActivation, false);
    assert.equal(report.authority.plannerInfluence, false);
    assert.equal(report.authority.representativeSelection, false);
    assert.equal(report.authority.likedTrackPreferenceRead, false);
    assert.equal(report.baseline.reconstructedTextualPairs, 1);
    assert.equal(report.provider.requestedDistinctTracks, 2);
    assert.equal(report.provider.tracksWithIsrc, 2);
    assert.equal(report.provider.tracksWithDuration, 2);
    assert.equal(report.preferences.loadedTrackPreferences, 0);
    assert.equal(report.comparison.canonicalRecordingCandidatePairs, 1);
    assert.equal(report.comparison.componentCount, 1);
    assert.equal(report.comparison.safeComponents, 1);
    assert.equal(report.comparison.blockedComponents, 0);
    assert.equal(report.comparison.hypotheticalReduction, 1);

    const component = report.comparison.samples[0];
    assert.ok(component);
    assert.equal(component.componentDecision, "SAFE_CANONICAL_COMPONENT");
    assert.equal(component.preferenceState, "NO_EXPLICIT_TRACK_PREFERENCE");
    assert.equal(component.memberCount, 2);
    assert.equal(component.internalPairCount, 1);
    assert.equal(component.expectedInternalPairCount, 1);
    assert.equal(component.canonicalShadow.hypotheticalRecordingCount, 1);
    assert.equal(component.canonicalShadow.representativeProviderTrackId, null);
    assert.equal(component.canonicalShadow.representativeRecordingIdentityId, null);
    assert.deepEqual(requestedIds, [["gate4b-remaster", "gate4b-standard"]]);

    const after = await snapshot(userId);
    assert.deepEqual(after, before);
  } finally {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

async function snapshot(userId: string) {
  return {
    artists: await prisma.artistIdentity.count({ where: { userId } }),
    songs: await prisma.songIdentity.count({ where: { userId } }),
    recordings: await prisma.recordingIdentity.count({ where: { userId } }),
    refs: await prisma.trackProviderRef.count({ where: { userId } }),
    preferences: await prisma.firstPartyPlaybackPreference.count({ where: { userId } }),
  };
}
