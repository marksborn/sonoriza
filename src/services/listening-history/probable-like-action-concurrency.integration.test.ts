import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  confirmProbableLike,
  ProbableLikeCandidateNotFoundError,
} from "./probable-like-action";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "concurrent Gate 5C confirmations cannot race provider-derived history past quarantine",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-concurrency-${suffix}@example.test` },
    });
    const spotifyArtistId = `same-artist-${suffix}`;
    const trackIds = [`same-artist-a-${suffix}`, `same-artist-b-${suffix}`];

    t.after(async () => {
      await prisma.historyLikeAction.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityEvidence.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityState.deleteMany({ where: { userId: user.id } });
      await prisma.likedTrackPreference.deleteMany({ where: { userId: user.id } });
      await prisma.trackListeningEvent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    const playedDates = [
      "2026-08-20T10:00:00.000Z",
      "2026-08-22T10:00:00.000Z",
      "2026-08-24T10:00:00.000Z",
    ];

    await prisma.trackListeningEvent.createMany({
      data: trackIds.flatMap((spotifyTrackId, trackIndex) =>
        playedDates.map((playedAt, playIndex) => ({
          userId: user.id,
          spotifyTrackId,
          spotifyUri: `spotify:track:${spotifyTrackId}`,
          trackName: `Concurrent Candidate ${trackIndex + 1}`,
          artistName: "Concurrent Artist",
          primaryArtistId: spotifyArtistId,
          playedAt: new Date(playedAt),
          source: "SPOTIFY_EXTENDED_HISTORY" as const,
          sourceEventKey: `concurrent-${trackIndex}-${playIndex}-${suffix}`,
          metadata: {
            spotifyExtendedHistory: {
              msPlayed: 205_000,
              reasonEnd: "trackdone",
              explicitSkip: false,
            },
          },
        })),
      ),
    });

    let identityResolutionAttempts = 0;
    let providerWriteAttempts = 0;

    const results = await Promise.allSettled(
      trackIds.map((spotifyTrackId) =>
        confirmProbableLike(
          { userId: user.id, spotifyTrackId },
          {
            resolveSpotifyIdentity: async () => {
              identityResolutionAttempts += 1;
              throw new Error("identity resolution must remain unreachable");
            },
            saveTrackToSpotify: async () => {
              providerWriteAttempts += 1;
              throw new Error("Spotify write must remain unreachable");
            },
          },
        ),
      ),
    );

    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof ProbableLikeCandidateNotFoundError);
      }
    }

    assert.equal(identityResolutionAttempts, 0);
    assert.equal(providerWriteAttempts, 0);
    assert.equal(
      await prisma.likedTrackPreference.count({ where: { userId: user.id } }),
      0,
    );
    assert.equal(
      await prisma.artistAffinityEvidence.count({ where: { userId: user.id } }),
      0,
    );
    assert.equal(
      await prisma.artistAffinityState.count({ where: { userId: user.id } }),
      0,
    );
    assert.equal(
      await prisma.historyLikeAction.count({ where: { userId: user.id } }),
      0,
    );
    assert.equal(
      await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
      6,
    );
  },
);
