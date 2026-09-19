import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

async function createUser(prefix: string): Promise<string> {
  const userId = `${prefix}-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId } });
  return userId;
}

async function createRecordingFixture(userId: string) {
  const suffix = randomUUID();
  const artist = await prisma.artistIdentity.create({
    data: {
      id: `artist-${suffix}`,
      userId,
      canonicalName: "Gate 2E Artist",
    },
  });
  const song = await prisma.songIdentity.create({
    data: {
      id: `song-${suffix}`,
      userId,
      primaryArtistIdentityId: artist.id,
      canonicalTitle: "Gate 2E Song",
    },
  });
  const recording = await prisma.recordingIdentity.create({
    data: {
      id: `recording-${suffix}`,
      userId,
      songIdentityId: song.id,
      versionClass: "STANDARD",
    },
  });

  return { artist, song, recording };
}

async function cleanupRecordingFixture(input: {
  userId: string;
  artistId: string;
  songId: string;
  recordingId: string;
}) {
  await prisma.trackProviderRef.deleteMany({
    where: { userId: input.userId, recordingIdentityId: input.recordingId },
  });
  await prisma.recordingIdentity
    .delete({ where: { id: input.recordingId } })
    .catch(() => undefined);
  await prisma.songIdentity
    .delete({ where: { id: input.songId } })
    .catch(() => undefined);
  await prisma.artistProviderRef.deleteMany({
    where: { userId: input.userId, artistIdentityId: input.artistId },
  });
  await prisma.artistIdentity
    .delete({ where: { id: input.artistId } })
    .catch(() => undefined);
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
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

databaseTest("composite foreign keys refuse cross-user canonical links", async () => {
  const ownerId = await createUser("identity-owner");
  const otherUserId = await createUser("identity-other");
  const suffix = randomUUID();

  const artist = await prisma.artistIdentity.create({
    data: {
      id: `artist-${suffix}`,
      userId: ownerId,
      canonicalName: "Owned Artist",
    },
  });
  const album = await prisma.albumIdentity.create({
    data: {
      id: `album-${suffix}`,
      userId: ownerId,
      canonicalTitle: "Owned Album",
    },
  });

  try {
    await assert.rejects(() =>
      prisma.songIdentity.create({
        data: {
          id: `cross-user-song-${suffix}`,
          userId: otherUserId,
          primaryArtistIdentityId: artist.id,
          canonicalTitle: "Must Fail",
        },
      }),
    );

    await assert.rejects(() =>
      prisma.albumReleaseIdentity.create({
        data: {
          id: `cross-user-release-${suffix}`,
          userId: otherUserId,
          albumIdentityId: album.id,
          editionLabel: "Must Fail",
        },
      }),
    );
  } finally {
    await cleanupUser(ownerId);
    await cleanupUser(otherUserId);
  }
});

databaseTest("track refs allow aliases but enforce execution, lineage, scope and natural-key guards", async () => {
  const suffix = randomUUID();
  const userId = await createUser("identity-track-user");
  const fixture = await createRecordingFixture(userId);

  try {
    await assert.rejects(() =>
      prisma.trackProviderRef.create({
        data: {
          id: `missing-uri-${suffix}`,
          userId,
          recordingIdentityId: fixture.recording.id,
          provider: "spotify",
          providerTrackId: `missing-uri-${suffix}`,
          uri: null,
          executionStatus: "EXECUTABLE",
          matchReason: "SINGLETON_BOOTSTRAP",
          confidenceBasisPoints: 10_000,
          resolutionLineage: { origins: ["SPOTIFY"] },
        },
      }),
    );

    await assert.rejects(() =>
      prisma.trackProviderRef.create({
        data: {
          id: `empty-lineage-${suffix}`,
          userId,
          recordingIdentityId: fixture.recording.id,
          provider: "spotify",
          providerTrackId: `empty-lineage-${suffix}`,
          uri: `spotify:track:empty-lineage-${suffix}`,
          executionStatus: "EXECUTABLE",
          matchReason: "SINGLETON_BOOTSTRAP",
          confidenceBasisPoints: 10_000,
          resolutionLineage: { origins: [] },
        },
      }),
    );

    await assert.rejects(() =>
      prisma.trackProviderRef.create({
        data: {
          id: `provider-case-${suffix}`,
          userId,
          recordingIdentityId: fixture.recording.id,
          provider: "SPOTIFY",
          providerTrackId: `provider-case-${suffix}`,
          uri: `spotify:track:provider-case-${suffix}`,
          executionStatus: "EXECUTABLE",
          matchReason: "SINGLETON_BOOTSTRAP",
          confidenceBasisPoints: 10_000,
          resolutionLineage: { origins: ["SPOTIFY"] },
        },
      }),
    );

    await assert.rejects(() =>
      prisma.trackProviderRef.create({
        data: {
          id: `scope-case-${suffix}`,
          userId,
          recordingIdentityId: fixture.recording.id,
          provider: "spotify",
          providerScope: "GLOBAL",
          providerTrackId: `scope-case-${suffix}`,
          uri: `spotify:track:scope-case-${suffix}`,
          executionStatus: "EXECUTABLE",
          matchReason: "SINGLETON_BOOTSTRAP",
          confidenceBasisPoints: 10_000,
          resolutionLineage: { origins: ["SPOTIFY"] },
        },
      }),
    );

    const first = await prisma.trackProviderRef.create({
      data: {
        id: `alias-a-${suffix}`,
        userId,
        recordingIdentityId: fixture.recording.id,
        provider: "spotify",
        providerTrackId: `alias-a-${suffix}`,
        uri: `spotify:track:alias-a-${suffix}`,
        executionStatus: "EXECUTABLE",
        matchReason: "SINGLETON_BOOTSTRAP",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });
    const second = await prisma.trackProviderRef.create({
      data: {
        id: `alias-b-${suffix}`,
        userId,
        recordingIdentityId: fixture.recording.id,
        provider: "spotify",
        providerScope: "global",
        providerTrackId: `alias-b-${suffix}`,
        uri: `spotify:track:alias-b-${suffix}`,
        executionStatus: "KNOWN",
        matchReason: "EXACT_PROVIDER_ALIAS",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

    assert.equal(first.providerScope, "global");
    assert.equal(second.providerScope, "global");
    assert.equal(first.recordingIdentityId, fixture.recording.id);
    assert.equal(second.recordingIdentityId, fixture.recording.id);
    assert.equal(
      await prisma.trackProviderRef.count({
        where: { userId, recordingIdentityId: fixture.recording.id },
      }),
      2,
    );

    await assert.rejects(() =>
      prisma.trackProviderRef.create({
        data: {
          id: `duplicate-${suffix}`,
          userId,
          recordingIdentityId: fixture.recording.id,
          provider: "spotify",
          providerScope: "global",
          providerTrackId: first.providerTrackId,
          uri: first.uri,
          executionStatus: "EXECUTABLE",
          matchReason: "EXACT_PROVIDER_ALIAS",
          confidenceBasisPoints: 10_000,
          resolutionLineage: { origins: ["SPOTIFY"] },
        },
      }),
    );
  } finally {
    await cleanupRecordingFixture({
      userId,
      artistId: fixture.artist.id,
      songId: fixture.song.id,
      recordingId: fixture.recording.id,
    });
    await cleanupUser(userId);
  }
});

databaseTest("user deletion cascades the canonical graph while direct parent deletion remains restricted", async () => {
  const userId = await createUser("identity-lifecycle");
  const suffix = randomUUID();

  const artist = await prisma.artistIdentity.create({
    data: { id: `artist-${suffix}`, userId, canonicalName: "Lifecycle Artist" },
  });
  await prisma.artistProviderRef.create({
    data: {
      id: `artist-ref-${suffix}`,
      userId,
      artistIdentityId: artist.id,
      provider: "spotify",
      providerArtistId: `artist-provider-${suffix}`,
      matchReason: "SINGLETON_BOOTSTRAP",
      confidenceBasisPoints: 10_000,
      resolutionLineage: { origins: ["SPOTIFY"] },
    },
  });
  const song = await prisma.songIdentity.create({
    data: {
      id: `song-${suffix}`,
      userId,
      primaryArtistIdentityId: artist.id,
      canonicalTitle: "Lifecycle Song",
    },
  });
  const recording = await prisma.recordingIdentity.create({
    data: { id: `recording-${suffix}`, userId, songIdentityId: song.id },
  });
  await prisma.trackProviderRef.create({
    data: {
      id: `track-ref-${suffix}`,
      userId,
      recordingIdentityId: recording.id,
      provider: "spotify",
      providerTrackId: `track-provider-${suffix}`,
      executionStatus: "KNOWN",
      matchReason: "SINGLETON_BOOTSTRAP",
      confidenceBasisPoints: 10_000,
      resolutionLineage: { origins: ["SPOTIFY"] },
    },
  });

  const album = await prisma.albumIdentity.create({
    data: { id: `album-${suffix}`, userId, canonicalTitle: "Lifecycle Album" },
  });
  const release = await prisma.albumReleaseIdentity.create({
    data: { id: `release-${suffix}`, userId, albumIdentityId: album.id },
  });
  await prisma.albumReleaseProviderRef.create({
    data: {
      id: `album-ref-${suffix}`,
      userId,
      albumReleaseIdentityId: release.id,
      provider: "spotify",
      providerAlbumId: `album-provider-${suffix}`,
      matchReason: "SINGLETON_BOOTSTRAP",
      confidenceBasisPoints: 10_000,
      resolutionLineage: { origins: ["SPOTIFY"] },
    },
  });

  await assert.rejects(() => prisma.artistIdentity.delete({ where: { id: artist.id } }));

  await prisma.user.delete({ where: { id: userId } });

  assert.equal(await prisma.artistIdentity.count({ where: { userId } }), 0);
  assert.equal(await prisma.songIdentity.count({ where: { userId } }), 0);
  assert.equal(await prisma.recordingIdentity.count({ where: { userId } }), 0);
  assert.equal(await prisma.artistProviderRef.count({ where: { userId } }), 0);
  assert.equal(await prisma.trackProviderRef.count({ where: { userId } }), 0);
  assert.equal(await prisma.albumIdentity.count({ where: { userId } }), 0);
  assert.equal(await prisma.albumReleaseIdentity.count({ where: { userId } }), 0);
  assert.equal(await prisma.albumReleaseProviderRef.count({ where: { userId } }), 0);
});
