import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { runMusicIdentityShadowBackfill } from "./shadow-backfill";

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
  albumId?: string;
  albumName?: string;
}) {
  await prisma.likedTrackPreference.create({
    data: {
      userId: input.userId,
      spotifyTrackId: input.trackId,
      spotifyUri: `spotify:track:${input.trackId}`,
      trackName: input.trackName,
      primaryArtistId: input.artistId,
      primaryArtistName: input.artistName,
      albumId: input.albumId ?? null,
      albumName: input.albumName ?? null,
      isLiked: true,
      availability: "AVAILABLE",
      firstProvenance: "LIKED_TRACK_SYNC",
      lastProvenance: "LIKED_TRACK_SYNC",
      lastObservedAt: new Date("2026-09-19T12:00:00.000Z"),
    },
  });
}

async function cleanupUser(userId: string) {
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

databaseTest("dry-run writes nothing and write mode is idempotent", async () => {
  const userId = await createUser("identity-2b-idempotent");

  try {
    await createLikedTrack({
      userId,
      trackId: "track-1",
      trackName: "Track One",
      artistId: "artist-1",
      artistName: "Artist One",
      albumId: "album-1",
      albumName: "Album One",
    });
    await createLikedTrack({
      userId,
      trackId: "track-2",
      trackName: "Track Two",
      artistId: "artist-1",
      artistName: "Artist One",
      albumId: "album-1",
      albumName: "Album One",
    });

    const dryRun = await runMusicIdentityShadowBackfill({ userId });
    assert.equal(dryRun.mode, "DRY_RUN");
    assert.equal(dryRun.candidateTracks, 2);
    assert.deepEqual(dryRun.created, {
      artistIdentities: 1,
      artistProviderRefs: 1,
      songIdentities: 2,
      recordingIdentities: 2,
      trackProviderRefs: 2,
      albumIdentities: 1,
      albumReleaseIdentities: 1,
      albumReleaseProviderRefs: 1,
    });
    assert.equal(await prisma.trackProviderRef.count({ where: { userId } }), 0);

    const firstWrite = await runMusicIdentityShadowBackfill({
      userId,
      write: true,
    });
    assert.equal(firstWrite.mode, "WRITE");
    assert.equal(firstWrite.alreadyPresentTrackRefs, 0);
    assert.deepEqual(firstWrite.created, dryRun.created);

    const refs = await prisma.trackProviderRef.findMany({
      where: { userId },
      orderBy: { providerTrackId: "asc" },
      select: {
        provider: true,
        providerTrackId: true,
        executionStatus: true,
        recordingIdentityId: true,
      },
    });
    assert.equal(refs.length, 2);
    assert.deepEqual(
      refs.map((ref) => ref.executionStatus),
      ["KNOWN", "KNOWN"],
    );
    assert.notEqual(refs[0]?.recordingIdentityId, refs[1]?.recordingIdentityId);
    assert.equal(await prisma.artistProviderRef.count({ where: { userId } }), 1);
    assert.equal(
      await prisma.albumReleaseProviderRef.count({ where: { userId } }),
      1,
    );

    const rerun = await runMusicIdentityShadowBackfill({
      userId,
      write: true,
    });
    assert.equal(rerun.alreadyPresentTrackRefs, 2);
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
  } finally {
    await cleanupUser(userId);
  }
});

databaseTest("same ISRC on different Spotify track IDs never merges recordings", async () => {
  const userId = await createUser("identity-2b-isrc");

  try {
    for (const [index, trackId] of ["track-a", "track-b"].entries()) {
      await prisma.trackListeningEvent.create({
        data: {
          userId,
          spotifyTrackId: trackId,
          spotifyUri: `spotify:track:${trackId}`,
          trackName: `Track ${index + 1}`,
          artistName: "Artist Shared",
          primaryArtistId: "artist-shared",
          albumName: null,
          albumId: null,
          isrc: "BRABC2600001",
          playedAt: new Date(`2026-09-19T12:0${index}:00.000Z`),
          source: "SPOTIFY_EXTENDED_HISTORY",
          sourceEventKey: `event-${trackId}`,
        },
      });
    }

    const result = await runMusicIdentityShadowBackfill({ userId, write: true });
    assert.equal(result.created.trackProviderRefs, 2);
    assert.equal(result.created.recordingIdentities, 2);

    const refs = await prisma.trackProviderRef.findMany({
      where: { userId },
      select: { isrc: true, recordingIdentityId: true },
    });
    assert.equal(refs.length, 2);
    assert.deepEqual(new Set(refs.map((ref) => ref.isrc)), new Set(["BRABC2600001"]));
    assert.equal(new Set(refs.map((ref) => ref.recordingIdentityId)).size, 2);
  } finally {
    await cleanupUser(userId);
  }
});

databaseTest("provider identities remain user-scoped", async () => {
  const userA = await createUser("identity-2b-user-a");
  const userB = await createUser("identity-2b-user-b");

  try {
    for (const userId of [userA, userB]) {
      await createLikedTrack({
        userId,
        trackId: "same-track",
        trackName: "Same Track",
        artistId: "same-artist",
        artistName: "Same Artist",
      });
      await runMusicIdentityShadowBackfill({ userId, write: true });
    }

    const refs = await prisma.trackProviderRef.findMany({
      where: { provider: "spotify", providerTrackId: "same-track" },
      select: { userId: true, recordingIdentityId: true },
    });
    const ours = refs.filter((ref) => ref.userId === userA || ref.userId === userB);
    assert.equal(ours.length, 2);
    assert.notEqual(ours[0]?.recordingIdentityId, ours[1]?.recordingIdentityId);
  } finally {
    await cleanupUser(userA);
    await cleanupUser(userB);
  }
});
