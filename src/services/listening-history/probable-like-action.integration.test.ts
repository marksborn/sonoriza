import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { confirmProbableLike } from "./probable-like-action";
import { getProbableLikeShadow } from "./probable-like";
import type { ResolvedProbableLikeSpotifyIdentity } from "./probable-like-spotify-identity";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

function resolvedIdentity(input: {
  historicalSpotifyTrackId: string;
  spotifyTrackId?: string;
  trackName: string;
  artistName: string;
  artistId: string;
  albumId?: string | null;
  albumName?: string | null;
  isrc?: string | null;
}): ResolvedProbableLikeSpotifyIdentity {
  const spotifyTrackId = input.spotifyTrackId ?? input.historicalSpotifyTrackId;
  return {
    historicalSpotifyTrackId: input.historicalSpotifyTrackId,
    spotifyTrackId,
    spotifyUri: `spotify:track:${spotifyTrackId}`,
    spotifyUrl: `https://open.spotify.com/track/${spotifyTrackId}`,
    trackName: input.trackName,
    primaryArtistId: input.artistId,
    primaryArtistName: input.artistName,
    albumId: input.albumId ?? null,
    albumName: input.albumName ?? null,
    durationMs: 210_000,
    isrc: input.isrc ?? null,
    resolution:
      spotifyTrackId === input.historicalSpotifyTrackId
        ? "HISTORICAL_ID_STILL_CURRENT"
        : input.isrc
          ? "ISRC_MATCH"
          : "TRACK_ARTIST_ALBUM_MATCH",
  };
}

integrationTest(
  "Gate 5 saves to Spotify first, confirms one canonical LIKE and propagates affinity idempotently",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-action-${suffix}@example.test` },
    });
    const spotifyTrackId = `gate5-track-${suffix}`;
    const spotifyArtistId = `gate5-artist-${suffix}`;
    const providerWrites: string[] = [];
    const saveTrackToSpotify = async (input: { spotifyTrackId: string }) => {
      // The provider must still see no local preference when it is called.
      assert.equal(
        await prisma.likedTrackPreference.count({
          where: { userId: user.id, spotifyTrackId },
        }),
        0,
      );
      providerWrites.push(input.spotifyTrackId);
    };
    const resolveSpotifyIdentity = async () =>
      resolvedIdentity({
        historicalSpotifyTrackId: spotifyTrackId,
        trackName: "Gate 5 Candidate",
        artistName: "Gate 5 Artist",
        artistId: spotifyArtistId,
        albumId: `gate5-album-${suffix}`,
        albumName: "Gate 5 Album",
      });

    t.after(async () => {
      await prisma.historyLikeAction.deleteMany({ where: { userId: user.id } });
      await prisma.probableLikePilotFeedback.deleteMany({
        where: { userId: user.id },
      });
      await prisma.artistAffinityEvidence.deleteMany({
        where: { userId: user.id },
      });
      await prisma.artistAffinityState.deleteMany({ where: { userId: user.id } });
      await prisma.likedTrackPreference.deleteMany({ where: { userId: user.id } });
      await prisma.trackListeningEvent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    const dates = [
      "2026-08-20T10:00:00.000Z",
      "2026-08-22T10:00:00.000Z",
      "2026-08-24T10:00:00.000Z",
    ];
    await prisma.trackListeningEvent.createMany({
      data: dates.map((playedAt, index) => ({
        userId: user.id,
        spotifyTrackId,
        spotifyUri: `spotify:track:${spotifyTrackId}`,
        trackName: "Gate 5 Candidate",
        artistName: "Gate 5 Artist",
        primaryArtistId: spotifyArtistId,
        albumId: `gate5-album-${suffix}`,
        albumName: "Gate 5 Album",
        playedAt: new Date(playedAt),
        source: "SPOTIFY_EXTENDED_HISTORY" as const,
        sourceEventKey: `gate5-${index}-${suffix}`,
        metadata: {
          spotifyExtendedHistory: {
            msPlayed: 210_000,
            reasonEnd: "trackdone",
            explicitSkip: false,
          },
        },
      })),
    });

    // Gate 4 feedback is measurement only and remains distinct from Gate 5.
    await prisma.probableLikePilotFeedback.create({
      data: {
        userId: user.id,
        spotifyTrackId,
        trackName: "Gate 5 Candidate",
        artistName: "Gate 5 Artist",
        verdict: "LIKED",
        candidateScore: 50,
        candidateReasons: ["pilot-only"],
        evaluatedAt: new Date("2026-08-25T10:00:00.000Z"),
      },
    });

    const before = await getProbableLikeShadow(user.id, { limit: 25 });
    assert.ok(before.candidates.some((item) => item.spotifyTrackId === spotifyTrackId));

    const first = await confirmProbableLike(
      { userId: user.id, spotifyTrackId },
      { saveTrackToSpotify, resolveSpotifyIdentity },
    );
    assert.deepEqual(providerWrites, [spotifyTrackId]);
    assert.equal(first.historicalSpotifyTrackId, spotifyTrackId);
    assert.equal(first.spotifyTrackId, spotifyTrackId);
    assert.equal(first.identityResolution, "HISTORICAL_ID_STILL_CURRENT");
    assert.equal(first.alreadyLiked, false);
    assert.equal(first.artistAffinityUpdated, true);
    assert.equal(first.providerWriteAttempted, true);
    assert.equal(first.providerWriteSucceeded, true);
    assert.equal(first.providerWriteReason, "SAVED_TO_SPOTIFY_LIBRARY");

    const preference = await prisma.likedTrackPreference.findUniqueOrThrow({
      where: { userId_spotifyTrackId: { userId: user.id, spotifyTrackId } },
    });
    assert.equal(preference.isLiked, true);
    assert.equal(preference.trackName, "Gate 5 Candidate");
    assert.equal(preference.primaryArtistId, spotifyArtistId);
    assert.equal(preference.firstProvenance, "LIKED_TRACK_SYNC");
    assert.equal(preference.lastProvenance, "LIKED_TRACK_SYNC");
    assert.equal(preference.addedAt, null);

    const evidence = await prisma.artistAffinityEvidence.findMany({
      where: { userId: user.id, spotifyTrackId, active: true },
    });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.spotifyArtistId, spotifyArtistId);

    const affinity = await prisma.artistAffinityState.findUniqueOrThrow({
      where: {
        userId_spotifyArtistId: {
          userId: user.id,
          spotifyArtistId,
        },
      },
    });
    assert.equal(affinity.active, true);
    assert.equal(affinity.likedTrackCount, 1);

    const action = await prisma.historyLikeAction.findUniqueOrThrow({
      where: {
        userId_spotifyTrackId_source: {
          userId: user.id,
          spotifyTrackId,
          source: "PROBABLE_LIKE",
        },
      },
    });
    assert.equal(action.trackName, "Gate 5 Candidate");
    assert.equal(action.artistAffinityUpdated, true);
    assert.equal(action.providerWriteAttempted, true);
    assert.equal(action.confirmCount, 1);

    const after = await getProbableLikeShadow(user.id, { limit: 25 });
    assert.equal(
      after.candidates.some((item) => item.spotifyTrackId === spotifyTrackId),
      false,
    );

    // A retry/double click after local materialization does not duplicate the
    // provider write, preference, affinity evidence or product provenance.
    const retry = await confirmProbableLike(
      { userId: user.id, spotifyTrackId },
      { saveTrackToSpotify, resolveSpotifyIdentity },
    );
    assert.equal(retry.alreadyLiked, true);
    assert.deepEqual(providerWrites, [spotifyTrackId]);
    assert.equal(
      await prisma.likedTrackPreference.count({
        where: { userId: user.id, spotifyTrackId },
      }),
      1,
    );
    assert.equal(
      await prisma.artistAffinityEvidence.count({
        where: { userId: user.id, spotifyTrackId, active: true },
      }),
      1,
    );
    assert.equal(
      await prisma.historyLikeAction.count({
        where: { userId: user.id, spotifyTrackId },
      }),
      1,
    );

    const pilotFeedback = await prisma.probableLikePilotFeedback.findUniqueOrThrow({
      where: { userId_spotifyTrackId: { userId: user.id, spotifyTrackId } },
    });
    assert.equal(pilotFeedback.verdict, "LIKED");
  },
);

integrationTest(
  "Gate 5 provider failure leaves the candidate and canonical preference untouched for retry",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-provider-failure-${suffix}@example.test` },
    });
    const spotifyTrackId = `provider-failure-${suffix}`;
    const spotifyArtistId = `provider-failure-artist-${suffix}`;

    t.after(async () => {
      await prisma.historyLikeAction.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityEvidence.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityState.deleteMany({ where: { userId: user.id } });
      await prisma.likedTrackPreference.deleteMany({ where: { userId: user.id } });
      await prisma.trackListeningEvent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.trackListeningEvent.createMany({
      data: [20, 22, 24].map((day, index) => ({
        userId: user.id,
        spotifyTrackId,
        spotifyUri: `spotify:track:${spotifyTrackId}`,
        trackName: "Provider Failure Candidate",
        artistName: "Provider Failure Artist",
        primaryArtistId: spotifyArtistId,
        playedAt: new Date(`2026-08-${day}T10:00:00.000Z`),
        source: "SPOTIFY_EXTENDED_HISTORY" as const,
        sourceEventKey: `provider-failure-${index}-${suffix}`,
        metadata: {
          spotifyExtendedHistory: {
            msPlayed: 200_000,
            reasonEnd: "trackdone",
            explicitSkip: false,
          },
        },
      })),
    });

    const before = await getProbableLikeShadow(user.id, { limit: 25 });
    assert.ok(before.candidates.some((item) => item.spotifyTrackId === spotifyTrackId));

    await assert.rejects(
      confirmProbableLike(
        { userId: user.id, spotifyTrackId },
        {
          resolveSpotifyIdentity: async () =>
            resolvedIdentity({
              historicalSpotifyTrackId: spotifyTrackId,
              trackName: "Provider Failure Candidate",
              artistName: "Provider Failure Artist",
              artistId: spotifyArtistId,
            }),
          saveTrackToSpotify: async () => {
            throw new Error("provider unavailable");
          },
        },
      ),
      /provider unavailable/,
    );

    assert.equal(
      await prisma.likedTrackPreference.count({ where: { userId: user.id } }),
      0,
    );
    assert.equal(
      await prisma.artistAffinityEvidence.count({ where: { userId: user.id } }),
      0,
    );
    assert.equal(
      await prisma.historyLikeAction.count({ where: { userId: user.id } }),
      0,
    );

    const after = await getProbableLikeShadow(user.id, { limit: 25 });
    assert.ok(after.candidates.some((item) => item.spotifyTrackId === spotifyTrackId));
  },
);

integrationTest(
  "Gate 5 relinks an obsolete historical Spotify id without mutating listening history",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-relinked-${suffix}@example.test` },
    });
    const historicalSpotifyTrackId = `historical-track-${suffix}`;
    const currentSpotifyTrackId = `current-track-${suffix}`;
    const currentSpotifyArtistId = `soilwork-current-${suffix}`;
    const providerWrites: string[] = [];

    t.after(async () => {
      await prisma.historyLikeAction.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityEvidence.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityState.deleteMany({ where: { userId: user.id } });
      await prisma.likedTrackPreference.deleteMany({ where: { userId: user.id } });
      await prisma.trackListeningEvent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.trackListeningEvent.createMany({
      data: [20, 22, 24].map((day, index) => ({
        userId: user.id,
        spotifyTrackId: historicalSpotifyTrackId,
        spotifyUri: `spotify:track:${historicalSpotifyTrackId}`,
        trackName: "Light the Torch",
        artistName: "Soilwork",
        primaryArtistId: `soilwork-historical-${suffix}`,
        albumId: `figure-number-five-old-${suffix}`,
        albumName: "Figure Number Five",
        isrc: "SEVAA0300104",
        playedAt: new Date(`2026-08-${day}T10:00:00.000Z`),
        source: "SPOTIFY_EXTENDED_HISTORY" as const,
        sourceEventKey: `relinked-${index}-${suffix}`,
        metadata: {
          spotifyExtendedHistory: {
            msPlayed: 210_000,
            reasonEnd: "trackdone",
            explicitSkip: false,
          },
        },
      })),
    });

    const before = await getProbableLikeShadow(user.id, { limit: 25 });
    assert.ok(
      before.candidates.some(
        (item) => item.spotifyTrackId === historicalSpotifyTrackId,
      ),
    );

    const result = await confirmProbableLike(
      { userId: user.id, spotifyTrackId: historicalSpotifyTrackId },
      {
        resolveSpotifyIdentity: async () =>
          resolvedIdentity({
            historicalSpotifyTrackId,
            spotifyTrackId: currentSpotifyTrackId,
            trackName: "Light The Torch",
            artistName: "Soilwork",
            artistId: currentSpotifyArtistId,
            albumId: `figure-number-five-current-${suffix}`,
            albumName: "Figure Number Five",
            isrc: "SEVAA0300104",
          }),
        saveTrackToSpotify: async ({ spotifyTrackId }) => {
          providerWrites.push(spotifyTrackId);
        },
      },
    );

    assert.deepEqual(providerWrites, [currentSpotifyTrackId]);
    assert.equal(result.historicalSpotifyTrackId, historicalSpotifyTrackId);
    assert.equal(result.spotifyTrackId, currentSpotifyTrackId);
    assert.equal(result.identityResolution, "ISRC_MATCH");

    const currentPreference = await prisma.likedTrackPreference.findUniqueOrThrow({
      where: {
        userId_spotifyTrackId: {
          userId: user.id,
          spotifyTrackId: currentSpotifyTrackId,
        },
      },
    });
    assert.equal(currentPreference.isLiked, true);
    assert.equal(currentPreference.trackName, "Light The Torch");
    assert.equal(currentPreference.primaryArtistId, currentSpotifyArtistId);

    assert.equal(
      await prisma.likedTrackPreference.count({
        where: {
          userId: user.id,
          spotifyTrackId: historicalSpotifyTrackId,
          isLiked: true,
        },
      }),
      0,
    );
    assert.equal(
      await prisma.trackListeningEvent.count({
        where: { userId: user.id, spotifyTrackId: historicalSpotifyTrackId },
      }),
      3,
    );

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
    assert.equal(action.primaryArtistId, currentSpotifyArtistId);

    const after = await getProbableLikeShadow(user.id, { limit: 25 });
    assert.equal(
      after.candidates.some(
        (item) => item.spotifyTrackId === historicalSpotifyTrackId,
      ),
      false,
    );
  },
);
