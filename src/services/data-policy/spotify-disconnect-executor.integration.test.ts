import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  SPOTIFY_DISCONNECT_ERROR_CODES,
  SpotifyDisconnectError,
  executeSpotifyDisconnect,
  prepareSpotifyDisconnect,
} from "./spotify-disconnect-executor";
import { SPOTIFY_DISCONNECT_CONTRACT_VERSION } from "./spotify-retention-contract";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 6B v2 disconnect is transactional and preserves independent providers plus MUSIC-06 explainability",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = new Date("2026-09-05T18:00:00.000Z");

    const user = await prisma.user.create({
      data: {
        email: `gate6b-v2-${suffix}@example.test`,
        name: "Spotify profile name",
        image: "https://example.test/provider-avatar.png",
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
          access_token: "spotify-access-secret",
          refresh_token: "spotify-refresh-secret",
          scope: "user-read-recently-played",
        },
        {
          userId: user.id,
          type: "oauth",
          provider: "google",
          providerAccountId: `google-${suffix}`,
          access_token: "google-access-secret",
          refresh_token: "google-refresh-secret",
          scope: "calendar.readonly",
        },
      ],
    });

    await prisma.calendarSelection.create({
      data: {
        userId: user.id,
        googleCalendarId: `calendar-${suffix}`,
        summary: "Independent Google calendar",
      },
    });

    await prisma.lastFmBackfillRun.create({
      data: {
        userId: user.id,
        username: `lastfm-${suffix}`,
        to: now,
      },
    });

    const pureLastFm = await prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        trackName: "Pure Last.fm Track",
        artistName: "Pure Last.fm Artist",
        playedAt: new Date("2026-09-05T17:00:00.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `lastfm-pure-${suffix}`,
        trackMbid: `track-mbid-${suffix}`,
      },
    });

    const mixed = await prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        spotifyTrackId: `spotify-track-${suffix}`,
        spotifyUri: `spotify:track:${suffix}`,
        trackName: "Mixed Last.fm Track",
        artistName: "Mixed Last.fm Artist",
        primaryArtistId: `spotify-artist-${suffix}`,
        albumName: "Spotify enriched album",
        albumId: `spotify-album-${suffix}`,
        playedAt: new Date("2026-09-05T17:05:00.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `lastfm-mixed-${suffix}`,
        contextType: "playlist",
        contextUri: `spotify:playlist:${suffix}`,
        metadata: {
          lastfmEvidence: { scrobble: true },
          spotifyExtendedHistory: { synthetic: true },
        },
      },
    });

    await prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        spotifyTrackId: `spotify-recent-${suffix}`,
        spotifyUri: `spotify:track:recent-${suffix}`,
        trackName: "Spotify Recent",
        artistName: "Spotify Artist",
        playedAt: new Date("2026-09-05T17:10:00.000Z"),
        source: "SPOTIFY_RECENTLY_PLAYED",
        sourceEventKey: `spotify-recent-${suffix}`,
      },
    });

    await prisma.trackListeningState.create({
      data: {
        userId: user.id,
        spotifyTrackId: `state-${suffix}`,
        spotifyUri: `spotify:track:state-${suffix}`,
        lastPlayedAt: now,
      },
    });

    await prisma.likedTrackPreference.create({
      data: {
        userId: user.id,
        spotifyTrackId: `liked-${suffix}`,
        spotifyUri: `spotify:track:liked-${suffix}`,
        trackName: "Legacy liked track",
        primaryArtistId: `artist-${suffix}`,
        primaryArtistName: "Legacy liked artist",
        availability: "AVAILABLE",
        firstProvenance: "LIKED_TRACK_SYNC",
        lastProvenance: "LIKED_TRACK_SYNC",
        lastObservedAt: now,
      },
    });

    const generation = await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "MANUAL",
        status: "SUCCESS",
        startedAt: now,
        finishedAt: now,
        summary: {
          music06PlannerInfluence: {
            status: "READY",
            evidenceMethod: "LASTFM_PLANNED_SEQUENCE_GAP",
            source: "Last.fm + Sonoriza",
          },
          spotifySnapshotId: `provider-${suffix}`,
        },
        error: "provider error payload",
      },
    });

    await prisma.firstPartyPlaybackPreference.create({
      data: {
        userId: user.id,
        subjectType: "ARTIST",
        subjectKey: `artist:first-party-${suffix}`,
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
    assert.equal(prepared.contractVersion, SPOTIFY_DISCONNECT_CONTRACT_VERSION);
    assert.equal(prepared.preview.destructive, true);
    assert.equal(prepared.inventory.oauthAccount, 1);
    assert.equal(prepared.inventory.unrelatedOauthAccount, 1);
    assert.equal(prepared.inventory.spotifyListeningEvent, 1);
    assert.equal(prepared.inventory.mixedListeningEvent, 1);
    assert.equal(prepared.inventory.pureLastFmListeningEvent, 1);

    await assert.rejects(
      executeSpotifyDisconnect(
        {
          userId: user.id,
          contractVersion: prepared.contractVersion,
          expectedFingerprint: prepared.fingerprint,
          confirmation: "DISCONNECT SPOTIFY",
        },
        { client: prisma },
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
      "failed confirmation must roll back without deleting credentials",
    );

    const result = await executeSpotifyDisconnect(
      {
        userId: user.id,
        contractVersion: prepared.contractVersion,
        expectedFingerprint: prepared.fingerprint,
        confirmation: prepared.confirmationPhrase,
      },
      { client: prisma },
    );

    assert.equal(result.afterPreview.destructive, false);
    assert.equal(result.afterInventory.oauthAccount, 0);
    assert.equal(result.afterInventory.spotifyListeningEvent, 0);
    assert.equal(result.afterInventory.mixedListeningEvent, 0);
    assert.equal(result.afterInventory.likedTrackPreference, 0);
    assert.equal(result.mutations.oauthAccountsDeleted, 1);
    assert.equal(result.mutations.spotifyListeningEventsDeleted, 1);
    assert.equal(result.mutations.mixedListeningEventsSanitized, 1);

    assert.equal(
      await prisma.account.count({
        where: { userId: user.id, provider: "google" },
      }),
      1,
    );
    assert.equal(
      await prisma.calendarSelection.count({ where: { userId: user.id } }),
      1,
    );
    assert.equal(
      await prisma.lastFmBackfillRun.count({ where: { userId: user.id } }),
      1,
    );

    const pureAfter = await prisma.trackListeningEvent.findUniqueOrThrow({
      where: { id: pureLastFm.id },
    });
    assert.equal(pureAfter.trackName, "Pure Last.fm Track");
    assert.equal(pureAfter.trackMbid, `track-mbid-${suffix}`);

    const mixedAfter = await prisma.trackListeningEvent.findUniqueOrThrow({
      where: { id: mixed.id },
    });
    assert.equal(mixedAfter.source, "LASTFM_SCROBBLE");
    assert.equal(mixedAfter.trackName, "Mixed Last.fm Track");
    assert.equal(mixedAfter.artistName, "Mixed Last.fm Artist");
    assert.equal(mixedAfter.sourceEventKey, `lastfm-mixed-${suffix}`);
    assert.equal(mixedAfter.spotifyTrackId, null);
    assert.equal(mixedAfter.spotifyUri, null);
    assert.equal(mixedAfter.primaryArtistId, null);
    assert.equal(mixedAfter.albumId, null);
    assert.equal(mixedAfter.albumName, null);
    assert.equal(mixedAfter.contextUri, null);
    assert.deepEqual(mixedAfter.metadata, {
      lastfmEvidence: { scrobble: true },
    });

    const generationAfter = await prisma.generationRun.findUniqueOrThrow({
      where: { id: generation.id },
    });
    assert.deepEqual(generationAfter.summary, {
      music06PlannerInfluence: {
        status: "READY",
        evidenceMethod: "LASTFM_PLANNED_SEQUENCE_GAP",
        source: "Last.fm + Sonoriza",
      },
    });
    assert.equal(generationAfter.error, null);

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

    const secondPreview = await prepareSpotifyDisconnect(user.id, prisma);
    assert.equal(secondPreview.preview.destructive, false);

    const secondResult = await executeSpotifyDisconnect(
      {
        userId: user.id,
        contractVersion: secondPreview.contractVersion,
        expectedFingerprint: secondPreview.fingerprint,
        confirmation: secondPreview.confirmationPhrase,
      },
      { client: prisma },
    );
    assert.equal(secondResult.afterPreview.destructive, false);
    assert.equal(secondResult.afterInventory.oauthAccount, 0);
  },
);

integrationTest(
  "Gate 6B v2 fails closed when the inventory changes after preview",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `gate6b-stale-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-stale-${suffix}`,
        access_token: "stale-access",
      },
    });

    const prepared = await prepareSpotifyDisconnect(user.id, prisma);

    await prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        spotifyTrackId: `late-${suffix}`,
        spotifyUri: `spotify:track:late-${suffix}`,
        trackName: "Late Spotify event",
        artistName: "Late Spotify artist",
        playedAt: new Date("2026-09-05T18:10:00.000Z"),
        source: "SPOTIFY_RECENTLY_PLAYED",
        sourceEventKey: `late-${suffix}`,
      },
    });

    await assert.rejects(
      executeSpotifyDisconnect(
        {
          userId: user.id,
          contractVersion: prepared.contractVersion,
          expectedFingerprint: prepared.fingerprint,
          confirmation: prepared.confirmationPhrase,
        },
        { client: prisma },
      ),
      (error) =>
        error instanceof SpotifyDisconnectError &&
        error.code === SPOTIFY_DISCONNECT_ERROR_CODES.PREVIEW_CHANGED,
    );

    assert.equal(
      await prisma.account.count({
        where: { userId: user.id, provider: "spotify" },
      }),
      1,
    );
    assert.equal(
      await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
      1,
    );
  },
);

test.after(async () => {
  await prisma.$disconnect();
});
