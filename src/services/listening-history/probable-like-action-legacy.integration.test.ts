import assert from "node:assert/strict";
import test from "node:test";

import {
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { confirmProbableLike } from "./probable-like-action";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

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
    const result = await confirmProbableLike(
      { userId: user.id, spotifyTrackId },
      {
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

    // Once the legacy confirmation has been backfilled, retries are local no-ops
    // and do not issue another provider write.
    const retry = await confirmProbableLike(
      { userId: user.id, spotifyTrackId },
      {
        saveTrackToSpotify: async ({ spotifyTrackId: providerTrackId }) => {
          providerWrites.push(providerTrackId);
        },
      },
    );
    assert.equal(retry.providerWriteReason, "ALREADY_LIKED");
    assert.deepEqual(providerWrites, [spotifyTrackId]);
  },
);
