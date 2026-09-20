import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { firstPartySpotifyTrackSubjectKey } from "@/services/music-preference/first-party-planner-preferences";
import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";
import { runMusicIdentityCanonicalPreferenceShadow } from "./canonical-preference-shadow";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

databaseTest("Gate 4A detects unilateral EXCLUDED and leaves identities/preferences unchanged", async () => {
  const suffix = randomUUID();
  const userId = `identity-gate4a-${suffix}`;

  await prisma.user.create({ data: { id: userId } });

  try {
    const artist = await prisma.artistIdentity.create({
      data: { userId, canonicalName: "Gate 4A Artist" },
    });
    await prisma.artistProviderRef.create({
      data: {
        userId,
        artistIdentityId: artist.id,
        provider: "spotify",
        providerScope: "global",
        providerArtistId: "gate4a-artist",
        matchReason: "SINGLETON_BOOTSTRAP",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

    const tracks = [
      {
        id: "gate4a-standard",
        title: "Gate 4A Song",
        albumId: "gate4a-album-standard",
        albumName: "Gate 4A Album",
        durationMs: 180_000,
      },
      {
        id: "gate4a-remaster",
        title: "Gate 4A Song - 2021 Remaster",
        albumId: "gate4a-album-remaster",
        albumName: "Gate 4A Album - 2021 Remaster",
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

    await prisma.firstPartyPlaybackPreference.create({
      data: {
        userId,
        subjectType: "TRACK",
        subjectKey: firstPartySpotifyTrackSubjectKey("gate4a-standard"),
        policy: "EXCLUDED",
        source: "USER_EXPLICIT",
      },
    });

    await prisma.sourcePlaylist.create({
      data: {
        userId,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "gate4a-source",
        name: "Gate 4A Source",
        cachedCandidates: {
          version: 5,
          unavailableTrackCount: 0,
          candidates: tracks.map((track) => ({
            uri: `spotify:track:${track.id}`,
            spotifyTrackId: track.id,
            title: track.title,
            subtitle: "Gate 4A Artist",
            primaryArtistId: "gate4a-artist",
            primaryArtistName: "Gate 4A Artist",
            albumId: track.albumId,
            albumName: track.albumName,
            durationMs: track.durationMs,
          })),
        } as Prisma.InputJsonValue,
        spotifySnapshotId: "gate4a-snapshot",
        cacheUpdatedAt: new Date("2026-09-20T14:00:00.000Z"),
      },
    });

    await prisma.targetPlaylist.create({
      data: {
        userId,
        name: "Gate 4A Target",
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
            isrc: "USGATE4A00001",
            artists: [
              {
                id: "gate4a-artist",
                name: "Gate 4A Artist",
                uri: "spotify:artist:gate4a-artist",
                spotifyUrl: null,
              },
            ],
            albumId: null,
            albumName: null,
            durationMs: id === "gate4a-standard" ? 180_000 : 181_000,
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

    const report = await runMusicIdentityCanonicalPreferenceShadow(userId, {
      provider,
    });

    if (report.mode !== "SHADOW_CANONICAL_DEDUPE_PREFERENCE_READ_ONLY") {
      assert.fail(`unexpected abstention: ${report.abstentionReason}`);
    }

    assert.equal(report.authority.identityWrites, false);
    assert.equal(report.authority.preferenceWrites, false);
    assert.equal(report.authority.plannerInfluence, false);
    assert.equal(report.authority.likedTrackPreferenceRead, false);
    assert.equal(report.baseline.reconstructedTextualPairs, 1);
    assert.equal(report.provider.requestedDistinctTracks, 2);
    assert.equal(report.provider.tracksWithIsrc, 2);
    assert.equal(report.provider.tracksWithDuration, 2);
    assert.equal(report.preferences.loadedTrackPreferences, 1);
    assert.equal(report.preferences.matchedTrackPreferences, 1);
    assert.equal(report.comparison.canonicalRecordingCandidatePairs, 1);
    assert.equal(report.comparison.preferenceConflictPairs, 1);
    assert.equal(report.comparison.presenceConflictPairs, 1);
    assert.equal(report.comparison.excludedConflictPairs, 1);
    assert.equal(report.comparison.preferenceSafePairs, 0);
    assert.equal(
      report.comparison.samples[0]?.activationDecision,
      "BLOCKED_PREFERENCE_SEMANTICS",
    );
    assert.equal(
      report.comparison.samples[0]?.canonicalShadow.representativeProviderTrackId,
      null,
    );
    assert.deepEqual(requestedIds, [["gate4a-remaster", "gate4a-standard"]]);

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
