import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  executeSpotifyDisconnect,
  prepareSpotifyDisconnect,
} from "./spotify-disconnect-executor";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 6F disconnect then authenticated OAuth relink preserves playlist bindings and first-party configuration",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const user = await prisma.user.create({
      data: {
        email: `gate6f-${suffix}@example.test`,
        name: "Provider profile name",
      },
    });

    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    await prisma.account.createMany({
      data: [
        {
          userId: user.id,
          type: "oauth",
          provider: "spotify",
          providerAccountId: `spotify-${suffix}`,
          access_token: "spotify-access",
          refresh_token: "spotify-refresh",
          scope: "playlist-read-private playlist-modify-private",
        },
        {
          userId: user.id,
          type: "oauth",
          provider: "google",
          providerAccountId: `google-${suffix}`,
          access_token: "google-access",
          refresh_token: "google-refresh",
          scope: "calendar.readonly",
        },
      ],
    });

    const sourceSpecs = [
      {
        kind: "MUSIC" as const,
        spotifyType: "PLAYLIST" as const,
        spotifyId: `music-a-${suffix}`,
        name: "Music A",
        enabled: true,
        includePlayed: false,
        episodeOrder: "SOURCE_DEFAULT" as const,
        musicRetentionMode: "KEEP_ALL" as const,
        musicCleanupAutomationEnabled: false,
      },
      {
        kind: "MUSIC" as const,
        spotifyType: "PLAYLIST" as const,
        spotifyId: `music-b-${suffix}`,
        name: "Music B",
        enabled: false,
        includePlayed: false,
        episodeOrder: "SOURCE_DEFAULT" as const,
        musicRetentionMode: "REMOVE_AFTER_PLAYED" as const,
        musicCleanupAutomationEnabled: true,
      },
      {
        kind: "PODCAST" as const,
        spotifyType: "SHOW" as const,
        spotifyId: `show-${suffix}`,
        name: "Podcast Show",
        enabled: true,
        includePlayed: false,
        episodeOrder: "OLDEST_FIRST" as const,
        musicRetentionMode: "KEEP_ALL" as const,
        musicCleanupAutomationEnabled: false,
      },
      {
        kind: "PODCAST" as const,
        spotifyType: "SAVED_EPISODES" as const,
        spotifyId: `saved-episodes-${suffix}`,
        name: "Saved Episodes",
        enabled: true,
        includePlayed: true,
        episodeOrder: "NEWEST_FIRST" as const,
        musicRetentionMode: "KEEP_ALL" as const,
        musicCleanupAutomationEnabled: false,
      },
    ];

    for (const source of sourceSpecs) {
      await prisma.sourcePlaylist.create({
        data: {
          userId: user.id,
          ...source,
          spotifySnapshotId: `snapshot-${source.spotifyId}`,
          cachedCandidates: [{ uri: `spotify:track:${source.spotifyId}` }],
          cacheUpdatedAt: new Date("2026-09-06T10:00:00.000Z"),
        },
      });
    }

    const sources = await prisma.sourcePlaylist.findMany({
      where: { userId: user.id },
      orderBy: { spotifyId: "asc" },
    });
    assert.equal(sources.length, 4);

    const podcastSource = sources.find((source) => source.spotifyType === "SHOW");
    assert.ok(podcastSource);

    await prisma.podcastShowPolicy.create({
      data: {
        sourcePlaylistId: podcastSource.id,
        episodeEligibility: "UNPLAYED_ONLY",
        episodeOrder: "OLDEST_FIRST",
        randomPolicy: "WITHOUT_REPLACEMENT",
        startEpisodeId: `episode-start-${suffix}`,
        strictSequence: true,
        maxReleaseAgeDays: 60,
        expiryPolicy: "ALLOW_IN_PROGRESS_TO_FINISH",
        maxEpisodesPerCycle: 2,
        sequenceCursorEpisodeId: `runtime-cursor-${suffix}`,
        sequenceCompleted: true,
        randomRound: 3,
        randomConsumedEpisodeIds: [`runtime-episode-${suffix}`],
      },
    });

    await prisma.musicPlaybackPolicy.create({
      data: {
        userId: user.id,
        enabled: true,
        windowValue: 45,
        windowUnit: "DAYS",
        historyKnownSince: new Date("2026-01-01T00:00:00.000Z"),
        lastSyncAt: new Date("2026-09-06T10:00:00.000Z"),
        syncAfterCursor: `cursor-${suffix}`,
      },
    });

    const ingestionTarget = sources.find((source) => source.kind === "MUSIC");
    assert.ok(ingestionTarget);

    await prisma.musicIngestionRule.create({
      data: {
        userId: user.id,
        targetSourcePlaylistId: ingestionTarget.id,
        type: "PLAYLIST_COPY",
        sourceSpotifyId: `ingestion-source-${suffix}`,
        sourceName: "Provider source name",
        enabled: true,
        initialMode: "FROM_NOW",
        state: { cursor: "provider-runtime" },
        capabilityStatus: "SUPPORTED",
        capabilityMessage: "provider runtime",
        lastSyncAt: new Date("2026-09-06T10:00:00.000Z"),
        lastSuccessAt: new Date("2026-09-06T10:00:00.000Z"),
      },
    });

    for (let index = 0; index < 4; index += 1) {
      await prisma.targetPlaylist.create({
        data: {
          userId: user.id,
          name: `Target ${index + 1}`,
          spotifyPlaylistId: `target-${index + 1}-${suffix}`,
          enabled: index !== 3,
          priority: index + 1,
          compositionMode: index % 2 === 0 ? "PROPORTION" : "SEQUENCE",
          musicOrderMode: index % 2 === 0 ? "STANDARD" : "RANDOMIZED",
          discoveryEnabled: index === 1,
          discoveryIntensity: index === 1 ? "EXPLORATORY" : "BALANCED",
          durationMode: "FIXED",
          fixedDurationSeconds: 1800 + index * 300,
          calendarMode: "LEGACY_GLOBAL",
          emptyCalendarBehavior: "KEEP",
          calendarEventFilterMode: "ALL",
          calendarDurationStrategy: "SUMMED",
          podcastPercent: 20 + index * 10,
          podcastEpisodeMaxDurationMode: "NONE",
          sequencePattern: ["MUSIC", "PODCAST"],
          maxEpisodesPerProgram: 1 + index,
          maxTracksPerArtist: 2 + index,
          maxTracksPerAlbum: 1 + index,
          updatePolicy: "MANUAL",
        },
      });
    }

    const sourceConfigBefore = await loadSourceConfiguration(user.id);
    const targetConfigBefore = await loadTargetConfiguration(user.id);
    const playbackPolicyBefore = await loadPlaybackPolicyConfiguration(user.id);
    const podcastPolicyBefore = await loadPodcastPolicyConfiguration(user.id);
    const ingestionRuleBefore = await loadIngestionConfiguration(user.id);

    assert.equal(sourceConfigBefore.length, 4);
    assert.equal(targetConfigBefore.length, 4);

    const prepared = await prepareSpotifyDisconnect(user.id, prisma);
    assert.equal(prepared.inventory.oauthAccount, 1);
    assert.equal(prepared.inventory.unrelatedOauthAccount, 1);
    assert.equal(prepared.inventory.sourcePlaylistBinding, 4);
    assert.equal(prepared.inventory.targetPlaylistBinding, 4);

    const disconnected = await executeSpotifyDisconnect(
      {
        userId: user.id,
        contractVersion: prepared.contractVersion,
        expectedFingerprint: prepared.fingerprint,
        confirmation: prepared.confirmationPhrase,
      },
      { client: prisma },
    );

    assert.equal(disconnected.afterInventory.oauthAccount, 0);
    assert.equal(disconnected.afterInventory.unrelatedOauthAccount, 1);
    assert.equal(disconnected.afterInventory.sourcePlaylistBinding, 4);
    assert.equal(disconnected.afterInventory.targetPlaylistBinding, 4);

    assert.deepEqual(await loadSourceConfiguration(user.id), sourceConfigBefore);
    assert.deepEqual(await loadTargetConfiguration(user.id), targetConfigBefore);
    assert.deepEqual(
      await loadPlaybackPolicyConfiguration(user.id),
      playbackPolicyBefore,
    );
    assert.deepEqual(
      await loadPodcastPolicyConfiguration(user.id),
      podcastPolicyBefore,
    );
    assert.deepEqual(await loadIngestionConfiguration(user.id), ingestionRuleBefore);

    // Simulates the Auth.js account-linking result after an authenticated
    // `signIn("spotify")`: the grant is attached back to the SAME Sonoriza User.
    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-${suffix}`,
        access_token: "spotify-access-reconnected",
        refresh_token: "spotify-refresh-reconnected",
        scope: "playlist-read-private playlist-modify-private",
      },
    });

    assert.equal(
      await prisma.account.count({
        where: { userId: user.id, provider: "spotify" },
      }),
      1,
    );
    assert.equal(await prisma.user.count({ where: { id: user.id } }), 1);

    assert.deepEqual(await loadSourceConfiguration(user.id), sourceConfigBefore);
    assert.deepEqual(await loadTargetConfiguration(user.id), targetConfigBefore);
    assert.deepEqual(
      await loadPlaybackPolicyConfiguration(user.id),
      playbackPolicyBefore,
    );
    assert.deepEqual(
      await loadPodcastPolicyConfiguration(user.id),
      podcastPolicyBefore,
    );
    assert.deepEqual(await loadIngestionConfiguration(user.id), ingestionRuleBefore);

    const reconnectedPreview = await prepareSpotifyDisconnect(user.id, prisma);
    assert.equal(reconnectedPreview.inventory.oauthAccount, 1);
    assert.equal(reconnectedPreview.inventory.unrelatedOauthAccount, 1);
    assert.equal(reconnectedPreview.inventory.sourcePlaylistBinding, 4);
    assert.equal(reconnectedPreview.inventory.targetPlaylistBinding, 4);
  },
);

async function loadSourceConfiguration(userId: string) {
  return prisma.sourcePlaylist.findMany({
    where: { userId },
    orderBy: { spotifyId: "asc" },
    select: {
      id: true,
      kind: true,
      spotifyType: true,
      spotifyId: true,
      enabled: true,
      includePlayed: true,
      episodeOrder: true,
      musicRetentionMode: true,
      musicCleanupAutomationEnabled: true,
      musicCleanupFirstCompletedAt: true,
      musicCleanupLastRunAt: true,
    },
  });
}

async function loadTargetConfiguration(userId: string) {
  return prisma.targetPlaylist.findMany({
    where: { userId },
    orderBy: { priority: "asc" },
    select: {
      id: true,
      name: true,
      spotifyPlaylistId: true,
      enabled: true,
      priority: true,
      compositionMode: true,
      musicOrderMode: true,
      discoveryEnabled: true,
      discoveryFamiliarEnabled: true,
      discoveryRediscoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryReleasesEnabled: true,
      discoveryIntensity: true,
      durationMode: true,
      fixedDurationSeconds: true,
      calendarMode: true,
      emptyCalendarBehavior: true,
      calendarEventFilterMode: true,
      calendarEventMarker: true,
      calendarDurationStrategy: true,
      podcastPercent: true,
      podcastEpisodeMaxDurationMode: true,
      podcastEpisodeMaxDurationSeconds: true,
      sequencePattern: true,
      maxEpisodesPerProgram: true,
      maxTracksPerArtist: true,
      maxTracksPerAlbum: true,
      updatePolicy: true,
      dailyScheduleMinutes: true,
      scheduleTimezone: true,
    },
  });
}

async function loadPlaybackPolicyConfiguration(userId: string) {
  return prisma.musicPlaybackPolicy.findUnique({
    where: { userId },
    select: {
      id: true,
      enabled: true,
      windowValue: true,
      windowUnit: true,
    },
  });
}

async function loadPodcastPolicyConfiguration(userId: string) {
  return prisma.podcastShowPolicy.findFirst({
    where: { source: { userId } },
    select: {
      sourcePlaylistId: true,
      episodeEligibility: true,
      episodeOrder: true,
      randomPolicy: true,
      startEpisodeId: true,
      strictSequence: true,
      maxReleaseAgeDays: true,
      expiryPolicy: true,
      maxEpisodesPerCycle: true,
    },
  });
}

async function loadIngestionConfiguration(userId: string) {
  return prisma.musicIngestionRule.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      targetSourcePlaylistId: true,
      type: true,
      sourceSpotifyId: true,
      enabled: true,
      initialMode: true,
    },
  });
}

test.after(async () => {
  await prisma.$disconnect();
});
