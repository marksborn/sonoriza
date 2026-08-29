import assert from "node:assert/strict";
import test from "node:test";

import {
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { confirmProbableLike } from "./probable-like-action";
import { loadHistoricalSpotifyTrackEvidence } from "./probable-like-spotify-identity";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "legacy identity resolution accepts explicit fallback evidence when listening events are absent",
  async () => {
    const evidence = await loadHistoricalSpotifyTrackEvidence({
      userId: "legacy-user-without-event",
      historicalSpotifyTrackId: "legacy-track-without-event",
      fallbackEvidence: {
        trackName: "Legacy Local Like",
        artistName: "Legacy Artist",
        primaryArtistId: "legacy-artist",
        albumName: "Legacy Album",
        isrc: null,
      },
    });

    assert.deepEqual(evidence, {
      historicalSpotifyTrackId: "legacy-track-without-event",
      trackName: "Legacy Local Like",
      artistName: "Legacy Artist",
      primaryArtistId: "legacy-artist",
      albumName: "Legacy Album",
      isrc: null,
    });
  },
);

integrationTest(
  "Gate 5 backfills a legacy Sonoriza-only confirmation to Spotify before declaring it saved",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `gate5-legacy-${suffix}@example.test` },
    });
    const spotifyTrackId = `gate5-legacy-track-${suffix}`;
    const spotifyArtistId = `gate5-legacy-artist-${suffix}`;
    const now = new Date("2026-08-29T19:00:00.000Z");

    t.after(async () => {
      await prisma.historyLikeAction.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityEvidence.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityState.deleteMany({ where: { userId: user.id } });
      await prisma.likedTrackPreference.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.likedTrackPreference.create({
      data: {
        userId: user.id,
        spotifyTrackId,
        spotifyUri: `spotify:track:${spotifyTrackId}`,
        trackName: "Legacy Local Like",
        primaryArtistId: spotifyArtistId,
        primaryArtistName: "Legacy Artist",
        addedAt: null,
        isLiked: true,
        availability: LikedTrackAvailability.AVAILABLE,
        firstProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        firstObservedAt: now,
        lastObservedAt: now,
      },
    });
    await prisma.historyLikeAction.create({
      data: {
        userId: user.id,
        spotifyTrackId,
        source: "PROBABLE_LIKE",
        trackName: "Legacy Local Like",
        artistName: "Legacy Artist",
        primaryArtistId: spotifyArtistId,
        candidateScore: 42,
        candidateReasons: ["legacy-gate5"],
        artistAffinityUpdated: true,
        providerWriteAttempted: false,
        firstConfirmedAt: now,
        lastConfirmedAt: now,
        confirmCount: 1,
      },
    });

    const providerWrites: string[] = [];
    const resolveSpotifyIdentity = async () => ({
      historicalSpotifyTrackId: spotifyTrackId,
      spotifyTrackId,
      spotifyUri: `spotify:track:${spotifyTrackId}`,
      spotifyUrl: `https://open.spotify.com/track/${spotifyTrackId}`,
      trackName: "Legacy Local Like",
      primaryArtistId: spotifyArtistId,
      primaryArtistName: "Legacy Artist",
      albumId: null,
      albumName: null,
      durationMs: 0,
      isrc: null,
      resolution: "HISTORICAL_ID_STILL_CURRENT" as const,
    });

    const result = await confirmProbableLike(
      { userId: user.id, spotifyTrackId },
      {
        resolveSpotifyIdentity,
        saveTrackToSpotify: async ({ spotifyTrackId: providerTrackId }) => {
          providerWrites.push(providerTrackId);
        },
      },
    );

    assert.deepEqual(providerWrites, [spotifyTrackId]);
    assert.equal(result.alreadyLiked, true);
    assert.equal(result.providerWriteAttempted, true);
    assert.equal(result.providerWriteSucceeded, true);
    assert.equal(result.providerWriteReason, "SAVED_TO_SPOTIFY_LIBRARY");

    const action = await prisma.historyLikeAction.findUniqueOrThrow({
      where: {
        userId_spotifyTrackId_source: {
          userId: user.id,
          spotifyTrackId,
          source: "PROBABLE_LIKE",
        },
      },
    });
    assert.equal(action.providerWriteAttempted, true);
    assert.equal(action.confirmCount, 2);

    const retry = await confirmProbableLike(
      { userId: user.id, spotifyTrackId },
      {
        resolveSpotifyIdentity,
        saveTrackToSpotify: async ({ spotifyTrackId: providerTrackId }) => {
          providerWrites.push(providerTrackId);
        },
      },
    );
    assert.equal(retry.providerWriteReason, "ALREADY_LIKED");
    assert.deepEqual(providerWrites, [spotifyTrackId]);
  },
);

integrationTest(
  "pending legacy relink demotes the obsolete duplicate when current Spotify id is already liked",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `gate5-legacy-relink-${suffix}@example.test` },
    });
    const historicalSpotifyTrackId = `legacy-old-${suffix}`;
    const currentSpotifyTrackId = `legacy-current-${suffix}`;
    const spotifyArtistId = `legacy-relink-artist-${suffix}`;
    const now = new Date("2026-08-29T19:00:00.000Z");

    t.after(async () => {
      await prisma.historyLikeAction.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityEvidence.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityState.deleteMany({ where: { userId: user.id } });
      await prisma.likedTrackPreference.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    for (const spotifyTrackId of [historicalSpotifyTrackId, currentSpotifyTrackId]) {
      await prisma.likedTrackPreference.create({
        data: {
          userId: user.id,
          spotifyTrackId,
          spotifyUri: `spotify:track:${spotifyTrackId}`,
          trackName: "Relinked Legacy Like",
          primaryArtistId: spotifyArtistId,
          primaryArtistName: "Relinked Artist",
          addedAt: spotifyTrackId === currentSpotifyTrackId ? now : null,
          isLiked: true,
          availability: LikedTrackAvailability.AVAILABLE,
          firstProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          firstObservedAt: now,
          lastObservedAt: now,
        },
      });
      await prisma.artistAffinityEvidence.create({
        data: {
          userId: user.id,
          spotifyTrackId,
          spotifyArtistId,
          artistName: "Relinked Artist",
          active: true,
          firstProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          firstObservedAt: now,
          lastChangedAt: now,
        },
      });
    }

    await prisma.artistAffinityState.create({
      data: {
        userId: user.id,
        spotifyArtistId,
        artistName: "Relinked Artist",
        likedTrackCount: 2,
        active: true,
        firstObservedAt: now,
        lastChangedAt: now,
      },
    });
    await prisma.historyLikeAction.create({
      data: {
        userId: user.id,
        spotifyTrackId: historicalSpotifyTrackId,
        source: "PROBABLE_LIKE",
        trackName: "Relinked Legacy Like",
        artistName: "Relinked Artist",
        primaryArtistId: spotifyArtistId,
        candidateScore: 42,
        candidateReasons: ["legacy-relink"],
        artistAffinityUpdated: true,
        providerWriteAttempted: false,
        firstConfirmedAt: now,
        lastConfirmedAt: now,
        confirmCount: 1,
      },
    });

    const providerWrites: string[] = [];
    const result = await confirmProbableLike(
      { userId: user.id, spotifyTrackId: historicalSpotifyTrackId },
      {
        resolveSpotifyIdentity: async () => ({
          historicalSpotifyTrackId,
          spotifyTrackId: currentSpotifyTrackId,
          spotifyUri: `spotify:track:${currentSpotifyTrackId}`,
          spotifyUrl: `https://open.spotify.com/track/${currentSpotifyTrackId}`,
          trackName: "Relinked Legacy Like",
          primaryArtistId: spotifyArtistId,
          primaryArtistName: "Relinked Artist",
          albumId: null,
          albumName: null,
          durationMs: 200_000,
          isrc: "BRABC2600002",
          resolution: "ISRC_MATCH" as const,
        }),
        saveTrackToSpotify: async ({ spotifyTrackId }) => {
          providerWrites.push(spotifyTrackId);
        },
      },
    );

    assert.equal(result.alreadyLiked, true);
    assert.equal(result.spotifyTrackId, currentSpotifyTrackId);
    assert.equal(result.providerWriteReason, "ALREADY_LIKED");
    assert.deepEqual(providerWrites, []);

    const oldPreference = await prisma.likedTrackPreference.findUniqueOrThrow({
      where: {
        userId_spotifyTrackId: {
          userId: user.id,
          spotifyTrackId: historicalSpotifyTrackId,
        },
      },
    });
    const currentPreference = await prisma.likedTrackPreference.findUniqueOrThrow({
      where: {
        userId_spotifyTrackId: {
          userId: user.id,
          spotifyTrackId: currentSpotifyTrackId,
        },
      },
    });
    assert.equal(oldPreference.isLiked, false);
    assert.equal(currentPreference.isLiked, true);

    assert.equal(
      await prisma.artistAffinityEvidence.count({
        where: {
          userId: user.id,
          spotifyTrackId: historicalSpotifyTrackId,
          active: true,
        },
      }),
      0,
    );
    assert.equal(
      await prisma.artistAffinityEvidence.count({
        where: {
          userId: user.id,
          spotifyTrackId: currentSpotifyTrackId,
          active: true,
        },
      }),
      1,
    );

    const affinity = await prisma.artistAffinityState.findUniqueOrThrow({
      where: {
        userId_spotifyArtistId: { userId: user.id, spotifyArtistId },
      },
    });
    assert.equal(affinity.likedTrackCount, 1);
    assert.equal(affinity.active, true);

    const action = await prisma.historyLikeAction.findUniqueOrThrow({
      where: {
        userId_spotifyTrackId_source: {
          userId: user.id,
          spotifyTrackId: historicalSpotifyTrackId,
          source: "PROBABLE_LIKE",
        },
      },
    });
    assert.equal(action.providerWriteAttempted, true);
    assert.equal(action.confirmCount, 2);
  },
);
