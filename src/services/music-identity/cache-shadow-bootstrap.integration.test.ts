import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { runMusicIdentityShadowBackfill } from "./shadow-backfill";
import { runMusicIdentityCacheShadowBootstrap } from "./cache-shadow-bootstrap";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

async function createUser(prefix: string): Promise<string> {
  const userId = `${prefix}-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId } });
  return userId;
}

async function createLikedTrack(input: {
  userId: string;
  trackId: string;
  trackName: string;
  artistId: string;
  artistName: string;
  albumId: string;
  albumName: string;
}) {
  await prisma.likedTrackPreference.create({
    data: {
      userId: input.userId,
      spotifyTrackId: input.trackId,
      spotifyUri: `spotify:track:${input.trackId}`,
      trackName: input.trackName,
      primaryArtistId: input.artistId,
      primaryArtistName: input.artistName,
      albumId: input.albumId,
      albumName: input.albumName,
      isLiked: true,
      availability: "AVAILABLE",
      firstProvenance: "LIKED_TRACK_SYNC",
      lastProvenance: "LIKED_TRACK_SYNC",
      lastObservedAt: new Date("2026-09-19T10:00:00.000Z"),
    },
  });
}

function fullCache() {
  return {
    version: 5,
    unavailableTrackCount: 0,
    candidates: [
      {
        uri: "spotify:track:track-existing",
        spotifyTrackId: "track-existing",
        title: "Existing Track",
        subtitle: "Existing Artist",
        primaryArtistId: "artist-existing",
        primaryArtistName: "Existing Artist",
        albumId: "album-existing",
        albumName: "Existing Album",
        durationMs: 180_000,
      },
      {
        uri: "spotify:track:track-reuse",
        spotifyTrackId: "track-reuse",
        title: "Reuse Track",
        subtitle: "Existing Artist",
        primaryArtistId: "artist-existing",
        primaryArtistName: "Existing Artist",
        albumId: "album-existing",
        albumName: "Existing Album",
        durationMs: 181_000,
      },
      {
        uri: "spotify:track:track-new",
        spotifyTrackId: "track-new",
        title: "New Track",
        subtitle: "New Artist",
        primaryArtistId: "artist-new",
        primaryArtistName: "New Artist",
        albumId: "album-new",
        albumName: "New Album",
        durationMs: 182_000,
      },
    ],
  } as Prisma.InputJsonValue;
}

async function cleanupUser(userId: string) {
  await prisma.targetPlaylist.deleteMany({ where: { userId } });
  await prisma.sourcePlaylist.deleteMany({ where: { userId } });
  await prisma.trackProviderRef.deleteMany({ where: { userId } });
  await prisma.recordingIdentity.deleteMany({ where: { userId } });
  await prisma.songIdentity.deleteMany({ where: { userId } });
  await prisma.artistProviderRef.deleteMany({ where: { userId } });
  await prisma.artistIdentity.deleteMany({ where: { userId } });
  await prisma.albumReleaseProviderRef.deleteMany({ where: { userId } });
  await prisma.albumReleaseIdentity.deleteMany({ where: { userId } });
  await prisma.albumIdentity.deleteMany({ where: { userId } });
  await prisma.trackListeningEvent.deleteMany({ where: { userId } });
  await prisma.likedTrackPreference.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

databaseTest("Gate 2D dry-run is read-only, reuses provider identities, writes KNOWN refs, and reruns idempotently", async () => {
  const userId = await createUser("identity-2d-idempotent");

  try {
    await createLikedTrack({
      userId,
      trackId: "track-existing",
      trackName: "Existing Track",
      artistId: "artist-existing",
      artistName: "Existing Artist",
      albumId: "album-existing",
      albumName: "Existing Album",
    });
    const seed = await runMusicIdentityShadowBackfill({ userId, write: true });
    assert.equal(seed.created.trackProviderRefs, 1);

    const existingBefore = await prisma.trackProviderRef.findUniqueOrThrow({
      where: {
        userId_provider_providerTrackId: {
          userId,
          provider: "spotify",
          providerTrackId: "track-existing",
        },
      },
      select: { recordingIdentityId: true },
    });

    await prisma.sourcePlaylist.create({
      data: {
        userId,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "gate2d-source",
        name: "Gate 2D Source",
        cachedCandidates: fullCache(),
        spotifySnapshotId: "snapshot-gate2d",
        cacheUpdatedAt: new Date("2026-09-19T12:00:00.000Z"),
      },
    });
    await prisma.targetPlaylist.create({
      data: { userId, name: "Gate 2D Target" },
    });

    const dryRun = await runMusicIdentityCacheShadowBootstrap({ userId });
    assert.equal(dryRun.mode, "DRY_RUN");
    assert.equal(dryRun.authority.providerCalls, false);
    assert.equal(dryRun.authority.plannerInfluence, false);
    assert.equal(dryRun.authority.cacheMutation, false);
    assert.equal(dryRun.selection.snapshotWriteAllowed, true);
    assert.equal(dryRun.cache.distinctSpotifyTracks, 3);
    assert.equal(dryRun.selection.alreadyCanonicalOperationalTracks, 1);
    assert.equal(dryRun.selection.candidateTracks, 2);
    assert.equal(dryRun.selection.skippedConflictTracks, 0);
    assert.equal(dryRun.selection.skippedIncompleteTracks, 0);
    assert.deepEqual(dryRun.planned, {
      alreadyPresentTrackRefs: 0,
      artistProviderRefsReused: 1,
      artistProviderRefsToCreate: 1,
      albumReleaseProviderRefsReused: 1,
      albumReleaseProviderRefsToCreate: 1,
      songIdentitiesToCreate: 2,
      recordingIdentitiesToCreate: 2,
      trackProviderRefsToCreate: 2,
    });
    assert.deepEqual(dryRun.created, {
      artistIdentities: 0,
      artistProviderRefs: 0,
      songIdentities: 0,
      recordingIdentities: 0,
      trackProviderRefs: 0,
      albumIdentities: 0,
      albumReleaseIdentities: 0,
      albumReleaseProviderRefs: 0,
    });
    assert.equal(await prisma.trackProviderRef.count({ where: { userId } }), 1);
    assert.deepEqual(dryRun.projectedCoverage, {
      coveredOperationalTracksAfterWrite: 3,
      basisPointsAfterWrite: 10_000,
    });

    const firstWrite = await runMusicIdentityCacheShadowBootstrap({ userId, write: true });
    assert.equal(firstWrite.mode, "WRITE");
    assert.equal(firstWrite.alreadyPresentDuringWrite, 0);
    assert.deepEqual(firstWrite.created, {
      artistIdentities: 1,
      artistProviderRefs: 1,
      songIdentities: 2,
      recordingIdentities: 2,
      trackProviderRefs: 2,
      albumIdentities: 1,
      albumReleaseIdentities: 1,
      albumReleaseProviderRefs: 1,
    });

    const refs = await prisma.trackProviderRef.findMany({
      where: { userId, provider: "spotify" },
      orderBy: { providerTrackId: "asc" },
      select: {
        providerTrackId: true,
        recordingIdentityId: true,
        executionStatus: true,
        resolutionLineage: true,
      },
    });
    assert.equal(refs.length, 3);
    assert.deepEqual(refs.map((ref) => ref.executionStatus), ["KNOWN", "KNOWN", "KNOWN"]);
    assert.ok(
      refs.every(
        (ref) =>
          JSON.stringify(ref.resolutionLineage) === JSON.stringify({ origins: ["SPOTIFY"] }),
      ),
    );

    const existingAfter = refs.find((ref) => ref.providerTrackId === "track-existing");
    assert.equal(existingAfter?.recordingIdentityId, existingBefore.recordingIdentityId);
    assert.equal(await prisma.artistProviderRef.count({ where: { userId } }), 2);
    assert.equal(await prisma.albumReleaseProviderRef.count({ where: { userId } }), 2);

    const rerun = await runMusicIdentityCacheShadowBootstrap({ userId, write: true });
    assert.equal(rerun.selection.alreadyCanonicalOperationalTracks, 3);
    assert.equal(rerun.selection.candidateTracks, 0);
    assert.equal(rerun.alreadyPresentDuringWrite, 0);
    assert.deepEqual(rerun.created, {
      artistIdentities: 0,
      artistProviderRefs: 0,
      songIdentities: 0,
      recordingIdentities: 0,
      trackProviderRefs: 0,
      albumIdentities: 0,
      albumReleaseIdentities: 0,
      albumReleaseProviderRefs: 0,
    });
    assert.deepEqual(rerun.projectedCoverage, {
      coveredOperationalTracksAfterWrite: 3,
      basisPointsAfterWrite: 10_000,
    });
  } finally {
    await cleanupUser(userId);
  }
});

databaseTest("Gate 2D write refuses partial persisted snapshots before creating identities", async () => {
  const userId = await createUser("identity-2d-partial");

  try {
    await prisma.sourcePlaylist.create({
      data: {
        userId,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "gate2d-partial-source",
        cachedCandidates: {
          version: 6,
          complete: false,
          unavailableTrackCount: 0,
          nextOffset: 50,
          candidates: [
            {
              uri: "spotify:track:track-partial",
              spotifyTrackId: "track-partial",
              title: "Partial",
              subtitle: null,
              primaryArtistId: "artist-partial",
              primaryArtistName: "Artist Partial",
              albumId: null,
              albumName: null,
              durationMs: 180_000,
            },
          ],
        } as Prisma.InputJsonValue,
        cacheUpdatedAt: new Date("2026-09-19T12:00:00.000Z"),
      },
    });
    await prisma.targetPlaylist.create({ data: { userId, name: "Partial Target" } });

    const dryRun = await runMusicIdentityCacheShadowBootstrap({ userId });
    assert.equal(dryRun.selection.snapshotWriteAllowed, false);
    assert.equal(dryRun.selection.abstentionReason, "INCOMPLETE_PERSISTED_SNAPSHOT");

    await assert.rejects(
      runMusicIdentityCacheShadowBootstrap({ userId, write: true }),
      /Gate 2D write aborted: INCOMPLETE_PERSISTED_SNAPSHOT/,
    );
    assert.equal(await prisma.trackProviderRef.count({ where: { userId } }), 0);
  } finally {
    await cleanupUser(userId);
  }
});
