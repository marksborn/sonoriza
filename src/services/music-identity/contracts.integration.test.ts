import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

const databaseTest = process.env.MUSIC_IDENTITY_DB_TEST === "1" ? test : test.skip;

async function createRecordingFixture(userId: string) {
  const suffix = randomUUID();
  const artist = await prisma.artistIdentity.create({
    data: {
      id: `artist-${suffix}`,
      userId,
      canonicalName: "Gate 2A Artist",
    },
  });
  const song = await prisma.songIdentity.create({
    data: {
      id: `song-${suffix}`,
      userId,
      primaryArtistIdentityId: artist.id,
      canonicalTitle: "Gate 2A Song",
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
  await prisma.artistIdentity
    .delete({ where: { id: input.artistId } })
    .catch(() => undefined);
}

databaseTest("composite foreign keys refuse cross-user canonical links", async () => {
  const suffix = randomUUID();
  const ownerId = `identity-owner-${suffix}`;
  const otherUserId = `identity-other-${suffix}`;

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
    await prisma.albumReleaseIdentity.deleteMany({
      where: { albumIdentityId: album.id },
    });
    await prisma.albumIdentity.delete({ where: { id: album.id } });
    await prisma.songIdentity.deleteMany({
      where: { primaryArtistIdentityId: artist.id },
    });
    await prisma.artistIdentity.delete({ where: { id: artist.id } });
  }
});

databaseTest("track refs allow aliases but enforce execution, lineage and natural-key guards", async () => {
  const suffix = randomUUID();
  const userId = `identity-track-user-${suffix}`;
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
        providerTrackId: `alias-b-${suffix}`,
        uri: `spotify:track:alias-b-${suffix}`,
        executionStatus: "KNOWN",
        matchReason: "EXACT_PROVIDER_ALIAS",
        confidenceBasisPoints: 10_000,
        resolutionLineage: { origins: ["SPOTIFY"] },
      },
    });

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
  }
});
