import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  SPOTIFY_DISCONNECT_ERROR_CODES,
  SpotifyDisconnectError,
  executeSpotifyDisconnect,
  prepareSpotifyDisconnect,
} from "./spotify-disconnect-executor";
import {
  SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX,
  SPOTIFY_DISCONNECT_REDACTED_TEXT,
  SPOTIFY_DISCONNECT_REDACTED_URI,
} from "./spotify-disconnect-redaction";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 6B disconnect is snapshot-authorized, transactional and preserves first-party rows",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = new Date("2026-09-02T18:00:00.000Z");
    const user = await prisma.user.create({
      data: { email: `gate6b-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.probableLikePilotFeedback.deleteMany({
        where: { userId: user.id },
      });
      await prisma.historyLikeAction.deleteMany({ where: { userId: user.id } });
      await prisma.historyProbableLikeDismissal.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-user-${suffix}`,
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_at: 2_000_000_000,
        scope: "user-read-recently-played",
      },
    });

    const musicSource = await prisma.sourcePlaylist.create({
      data: {
        userId: user.id,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: `music-source-${suffix}`,
        name: "Provider Music Source",
        spotifySnapshotId: "source-snapshot",
        cachedCandidates: [{ uri: "spotify:track:cached" }],
        cacheUpdatedAt: now,
      },
    });
    const podcastSource = await prisma.sourcePlaylist.create({
      data: {
        userId: user.id,
        kind: "PODCAST",
        spotifyType: "SHOW",
        spotifyId: `podcast-source-${suffix}`,
        name: "Provider Podcast Source",
      },
    });
    await prisma.podcastShowPolicy.create({
      data: {
        sourcePlaylistId: podcastSource.id,
        startEpisodeId: "explicit-start-episode",
        sequenceCursorEpisodeId: "provider-cursor-episode",
        sequenceCompleted: true,
        randomRound: 3,
        randomConsumedEpisodeIds: ["episode-1", "episode-2"],
      },
    });
    await prisma.musicPlaybackPolicy.create({
      data: {
        userId: user.id,
        enabled: true,
        windowValue: 30,
        windowUnit: "DAYS",
        historyKnownSince: new Date("2025-01-01T00:00:00.000Z"),
        lastSyncAt: now,
        syncAfterCursor: "spotify-cursor",
      },
    });

    const target = await prisma.targetPlaylist.create({
      data: {
        userId: user.id,
        name: "Keep Target",
        spotifyPlaylistId: `target-${suffix}`,
        sequencePattern: [],
      },
    });

    const rule = await prisma.musicIngestionRule.create({
      data: {
        userId: user.id,
        targetSourcePlaylistId: musicSource.id,
        type: "PLAYLIST_COPY",
        sourceSpotifyId: `source-binding-${suffix}`,
        sourceName: "Provider Rule Source",
        enabled: true,
        state: { cursor: "provider-cursor" },
        capabilityStatus: "SUPPORTED",
        capabilityMessage: "provider capability payload",
        lastSyncAt: now,
        lastSuccessAt: now,
      },
    });

    await prisma.musicSourceCleanupRun.create({
      data: {
        userId: user.id,
        sourcePlaylistId: musicSource.id,
        status: "SUCCESS",
        snapshotBefore: "provider-before",
        snapshotAfter: "provider-after",
        planHash: "provider-plan-hash",
        examinedCount: 2,
        removableTrackCount: 1,
        removalOccurrenceCount: 1,
        keptCount: 1,
        plannedUris: ["spotify:track:remove"],
        removedUris: ["spotify:track:remove"],
        failedUris: [],
        startedAt: now,
        finishedAt: now,
        error: "provider cleanup payload",
      },
    });
    await prisma.musicIngestionRun.create({
      data: {
        userId: user.id,
        ruleId: rule.id,
        targetSourcePlaylistId: musicSource.id,
        ruleType: "PLAYLIST_COPY",
        trigger: "MANUAL",
        status: "SUCCESS",
        details: { spotifyTrackId: "provider-track" },
        startedAt: now,
        finishedAt: now,
        error: "provider ingestion payload",
      },
    });

    const generation = await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "MANUAL",
        status: "SUCCESS",
        startedAt: now,
        finishedAt: now,
        summary: { spotifySnapshotId: "generation-provider-snapshot" },
        error: "provider generation error",
      },
    });
    await prisma.generationItem.create({
      data: {
        runId: generation.id,
        targetPlaylistId: target.id,
        position: 1,
        contentType: "MUSIC",
        spotifyUri: "spotify:track:generation",
        title: "Provider Track",
        subtitle: "Provider Artist",
        programId: "provider-program",
        durationMs: 180_000,
        spotifyTrackId: "generation-track",
        primaryArtistId: "generation-artist",
        albumId: "generation-album",
        originalDurationMs: 180_000,
        resumePositionMs: 1_000,
        sourceSpotifyType: "PLAYLIST",
        sourceSpotifyId: musicSource.spotifyId,
      },
    });
    await prisma.generationLog.create({
      data: {
        runId: generation.id,
        level: "INFO",
        message: "Spotify provider diagnostic",
        data: { spotifyTrackId: "generation-track" },
      },
    });

    const scheduleRun = await prisma.targetScheduleRun.create({
      data: {
        userId: user.id,
        targetPlaylistId: target.id,
        scheduleKey: `gate6b-${suffix}`,
        scheduledLocalDate: "2026-09-02",
        scheduledForMinutes: 1080,
        scheduleTimezone: "America/Sao_Paulo",
        policy: "MANUAL",
        status: "SUCCESS",
        snapshotBefore: "schedule-provider-before",
        snapshotAfter: "schedule-provider-after",
        reason: "provider schedule reason",
        details: { spotifySnapshotId: "schedule-provider-snapshot" },
        startedAt: now,
        finishedAt: now,
      },
    });
    await prisma.targetScheduleAttempt.create({
      data: {
        targetScheduleRunId: scheduleRun.id,
        attempt: 1,
        status: "SUCCESS",
        reason: "provider attempt reason",
        details: { spotifyId: "attempt-provider-id" },
        startedAt: now,
        finishedAt: now,
      },
    });

    await prisma.trackListeningState.create({
      data: {
        userId: user.id,
        spotifyTrackId: "recent-track",
        spotifyUri: "spotify:track:recent-track",
        lastPlayedAt: now,
      },
    });
    await prisma.trackListeningEvent.createMany({
      data: [
        {
          userId: user.id,
          spotifyTrackId: "provider-event-track",
          spotifyUri: "spotify:track:provider-event-track",
          trackName: "Provider Event",
          artistName: "Provider Artist",
          albumName: "Provider Album",
          playedAt: now,
          source: "SPOTIFY_RECENTLY_PLAYED",
          sourceEventKey: `spotify-${suffix}`,
        },
        {
          userId: user.id,
          spotifyTrackId: "mixed-provider-track",
          spotifyUri: "spotify:track:mixed-provider-track",
          trackName: "Independent Last.fm Event",
          artistName: "Independent Artist",
          primaryArtistId: "mixed-provider-artist",
          albumName: "Provider-enriched Album",
          albumId: "mixed-provider-album",
          playedAt: new Date("2018-01-01T00:00:00.000Z"),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: `lastfm-${suffix}`,
          contextType: "playlist",
          contextUri: "spotify:playlist:mixed-context",
          metadata: {
            lastfmEvidence: { scrobble: true },
            spotifyExtendedHistory: { packageSha256: "provider-package" },
          },
        },
      ],
    });
    await prisma.spotifyExtendedHistoryImportRun.create({
      data: {
        userId: user.id,
        packageSha256: `package-${suffix}`,
        planHash: `plan-${suffix}`,
        status: "SUCCESS",
        uniqueMusicEvents: 1,
        insertPlanned: 1,
        enrichPlanned: 0,
        quarantinePlanned: 0,
        insertedEvents: 1,
        finishedAt: now,
      },
    });
    await prisma.episodeListeningState.create({
      data: {
        userId: user.id,
        spotifyEpisodeId: `episode-${suffix}`,
        spotifyUri: `spotify:episode:${suffix}`,
        durationMs: 60_000,
        resumePositionMs: 30_000,
        status: "IN_PROGRESS",
        lastObservedAt: now,
      },
    });

    const liked = await prisma.likedTrackPreference.create({
      data: {
        userId: user.id,
        spotifyTrackId: `liked-${suffix}`,
        spotifyUri: `spotify:track:liked-${suffix}`,
        trackName: "Provider Liked Track",
        primaryArtistId: `artist-${suffix}`,
        primaryArtistName: "Provider Liked Artist",
        availability: "AVAILABLE",
        firstProvenance: "LIKED_TRACK_SYNC",
        lastProvenance: "LIKED_TRACK_SYNC",
        lastObservedAt: now,
      },
    });
    await prisma.artistAffinityEvidence.create({
      data: {
        userId: user.id,
        spotifyTrackId: liked.spotifyTrackId,
        spotifyArtistId: `artist-${suffix}`,
        artistName: "Provider Liked Artist",
        type: "LIKED_TRACK",
        active: true,
        firstProvenance: "LIKED_TRACK_SYNC",
        lastProvenance: "LIKED_TRACK_SYNC",
        lastChangedAt: now,
      },
    });
    await prisma.artistAffinityState.create({
      data: {
        userId: user.id,
        spotifyArtistId: `artist-${suffix}`,
        artistName: "Provider Liked Artist",
        likedTrackCount: 1,
        active: true,
        lastChangedAt: now,
      },
    });
    const seed = await prisma.artistSimilaritySeedState.create({
      data: {
        userId: user.id,
        provider: "LASTFM",
        sourceSpotifyArtistId: `artist-${suffix}`,
        sourceArtistName: "Provider Root Artist",
      },
    });
    await prisma.artistSimilarityEdge.create({
      data: {
        userId: user.id,
        seedStateId: seed.id,
        provider: "LASTFM",
        sourceSpotifyArtistId: seed.sourceSpotifyArtistId,
        sourceArtistName: seed.sourceArtistName,
        candidateKey: `candidate-${suffix}`,
        candidateArtistName: "Last.fm Candidate",
        similarity: 0.9,
        lastObservedAt: now,
      },
    });
    await prisma.musicPreferenceSignal.create({
      data: {
        userId: user.id,
        spotifyTrackId: `skip-${suffix}`,
        spotifyUri: `spotify:track:skip-${suffix}`,
        type: "INFERRED_SKIP",
        sourceGenerationRunId: generation.id,
        targetPlaylistId: target.id,
        position: 1,
      },
    });
    await prisma.albumRecommendationMemory.create({
      data: {
        userId: user.id,
        spotifyAlbumId: `album-${suffix}`,
        state: "RECOMMENDED",
        artistName: "Provider Album Artist",
        albumName: "Provider Album",
      },
    });

    await prisma.probableLikePilotFeedback.create({
      data: {
        userId: user.id,
        spotifyTrackId: `pilot-${suffix}`,
        trackName: "Provider Pilot Track",
        artistName: "Provider Pilot Artist",
        verdict: "LIKED",
        candidateScore: 91,
        candidateReasons: ["provider-derived reason"],
      },
    });
    await prisma.historyLikeAction.create({
      data: {
        userId: user.id,
        spotifyTrackId: `history-like-${suffix}`,
        source: "PROBABLE_LIKE",
        trackName: "Provider History Track",
        artistName: "Provider History Artist",
        primaryArtistId: `history-artist-${suffix}`,
        candidateScore: 88,
        candidateReasons: ["provider-derived reason"],
        artistAffinityUpdated: true,
        providerWriteAttempted: true,
        lastConfirmedAt: now,
      },
    });
    await prisma.historyProbableLikeDismissal.create({
      data: {
        userId: user.id,
        spotifyTrackId: `dismiss-${suffix}`,
        source: "PROBABLE_LIKE",
        trackName: "Provider Dismiss Track",
        artistName: "Provider Dismiss Artist",
        candidateScore: 77,
        candidateReasons: ["provider-derived reason"],
        lastDismissedAt: now,
        suppressUntil: new Date("2026-09-09T18:00:00.000Z"),
      },
    });

    await prisma.firstPartyPlaybackPreference.create({
      data: {
        userId: user.id,
        subjectType: "ARTIST",
        subjectKey: "artist:explicit-first-party",
        policy: "EXCLUDED",
        source: "USER_EXPLICIT",
      },
    });
    await prisma.nativeSourcePreference.create({
      data: {
        userId: user.id,
        type: "LIKED_TRACKS",
        enabled: true,
      },
    });

    const prepared = await prepareSpotifyDisconnect(user.id, prisma);
    assert.equal(prepared.preview.destructive, true);
    assert.equal(prepared.inventory.oauthAccount, 1);
    assert.equal(prepared.inventory.mixedListeningEvent, 1);

    await assert.rejects(
      executeSpotifyDisconnect(
        {
          userId: user.id,
          expectedFingerprint: prepared.fingerprint,
          confirmation: "DISCONNECT SPOTIFY",
        },
        { client: prisma, lockTables: async () => {} },
      ),
      (error) =>
        error instanceof SpotifyDisconnectError &&
        error.code === SPOTIFY_DISCONNECT_ERROR_CODES.CONFIRMATION_REQUIRED,
    );
    assert.equal(
      await prisma.account.count({
        where: { userId: user.id, provider: "spotify" },
      }),
      1,
    );

    const result = await executeSpotifyDisconnect(
      {
        userId: user.id,
        expectedFingerprint: prepared.fingerprint,
        confirmation: prepared.confirmationPhrase,
      },
      { client: prisma, lockTables: async () => {} },
    );

    assert.equal(result.afterPreview.destructive, false);
    assert.equal(result.afterInventory.oauthAccount, 0);
    assert.equal(result.afterInventory.spotifyListeningEvent, 0);
    assert.equal(result.afterInventory.mixedListeningEvent, 0);
    assert.equal(result.afterInventory.likedTrackPreference, 0);
    assert.equal(result.afterInventory.generationAuditWithProviderFields, 0);

    assert.equal(
      await prisma.account.count({
        where: { userId: user.id, provider: "spotify" },
      }),
      0,
    );
    assert.equal(
      await prisma.trackListeningEvent.count({
        where: { userId: user.id, source: "SPOTIFY_RECENTLY_PLAYED" },
      }),
      0,
    );
    const mixed = await prisma.trackListeningEvent.findFirstOrThrow({
      where: { userId: user.id, source: "LASTFM_SCROBBLE" },
    });
    assert.equal(mixed.spotifyTrackId, null);
    assert.equal(mixed.spotifyUri, null);
    assert.equal(mixed.primaryArtistId, null);
    assert.equal(mixed.albumId, null);
    assert.equal(mixed.albumName, null);
    assert.equal(mixed.contextType, null);
    assert.equal(mixed.contextUri, null);
    assert.deepEqual(mixed.metadata, { lastfmEvidence: { scrobble: true } });

    const preservedMusicSource = await prisma.sourcePlaylist.findUniqueOrThrow({
      where: { id: musicSource.id },
    });
    assert.equal(preservedMusicSource.spotifyId, musicSource.spotifyId);
    assert.equal(preservedMusicSource.name, null);
    assert.equal(preservedMusicSource.cachedCandidates, null);
    assert.equal(preservedMusicSource.spotifySnapshotId, null);

    const preservedTarget = await prisma.targetPlaylist.findUniqueOrThrow({
      where: { id: target.id },
    });
    assert.equal(preservedTarget.spotifyPlaylistId, target.spotifyPlaylistId);

    const playbackPolicy = await prisma.musicPlaybackPolicy.findUniqueOrThrow({
      where: { userId: user.id },
    });
    assert.equal(playbackPolicy.enabled, true);
    assert.equal(playbackPolicy.windowValue, 30);
    assert.equal(playbackPolicy.historyKnownSince, null);
    assert.equal(playbackPolicy.lastSyncAt, null);
    assert.equal(playbackPolicy.syncAfterCursor, null);

    const podcastPolicy = await prisma.podcastShowPolicy.findUniqueOrThrow({
      where: { sourcePlaylistId: podcastSource.id },
    });
    assert.equal(podcastPolicy.startEpisodeId, "explicit-start-episode");
    assert.equal(podcastPolicy.sequenceCursorEpisodeId, null);
    assert.equal(podcastPolicy.sequenceCompleted, false);
    assert.equal(podcastPolicy.randomRound, 0);
    assert.deepEqual(podcastPolicy.randomConsumedEpisodeIds, []);

    const preservedRule = await prisma.musicIngestionRule.findUniqueOrThrow({
      where: { id: rule.id },
    });
    assert.equal(preservedRule.sourceSpotifyId, `source-binding-${suffix}`);
    assert.equal(preservedRule.sourceName, null);
    assert.equal(preservedRule.state, null);
    assert.equal(preservedRule.capabilityStatus, "UNKNOWN");

    const generationItem = await prisma.generationItem.findFirstOrThrow({
      where: { runId: generation.id },
    });
    assert.equal(generationItem.spotifyUri, SPOTIFY_DISCONNECT_REDACTED_URI);
    assert.equal(generationItem.spotifyTrackId, null);
    assert.equal(generationItem.title, null);
    const generationLog = await prisma.generationLog.findFirstOrThrow({
      where: { runId: generation.id },
    });
    assert.equal(generationLog.message, SPOTIFY_DISCONNECT_REDACTED_TEXT);
    assert.equal(generationLog.data, null);

    const pilot = await prisma.probableLikePilotFeedback.findFirstOrThrow({
      where: { userId: user.id },
    });
    assert.equal(pilot.verdict, "LIKED");
    assert.match(pilot.spotifyTrackId, new RegExp(`^${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX}`));
    assert.equal(pilot.trackName, SPOTIFY_DISCONNECT_REDACTED_TEXT);
    assert.equal(pilot.candidateScore, 0);

    const historyLike = await prisma.historyLikeAction.findFirstOrThrow({
      where: { userId: user.id },
    });
    assert.equal(historyLike.providerWriteAttempted, true);
    assert.match(historyLike.spotifyTrackId, new RegExp(`^${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX}`));
    assert.equal(historyLike.primaryArtistId, null);
    assert.equal(historyLike.artistAffinityUpdated, false);

    assert.equal(
      await prisma.firstPartyPlaybackPreference.count({
        where: { userId: user.id },
      }),
      1,
    );
    assert.equal(
      await prisma.nativeSourcePreference.count({ where: { userId: user.id } }),
      1,
    );
    assert.equal(await prisma.user.count({ where: { id: user.id } }), 1);
  },
);
