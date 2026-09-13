import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  confirmProbableLike,
  ProbableLikeCandidateNotFoundError,
} from "./probable-like-action";
import { getProbableLikeShadow } from "./probable-like";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 5C quarantines provider-derived probable-like before identity, Spotify or local LIKE writes",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-quarantine-${suffix}@example.test` },
    });
    const spotifyTrackId = `gate5c-quarantined-${suffix}`;
    const spotifyArtistId = `gate5c-artist-${suffix}`;

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

    await prisma.trackListeningEvent.createMany({
      data: [20, 22, 24].map((day, index) => ({
        userId: user.id,
        spotifyTrackId,
        spotifyUri: `spotify:track:${spotifyTrackId}`,
        trackName: "Quarantined Candidate",
        artistName: "Quarantined Artist",
        primaryArtistId: spotifyArtistId,
        playedAt: new Date(`2026-08-${day}T10:00:00.000Z`),
        source: "SPOTIFY_EXTENDED_HISTORY" as const,
        sourceEventKey: `gate5c-${index}-${suffix}`,
        metadata: {
          spotifyExtendedHistory: {
            msPlayed: 210_000,
            reasonEnd: "trackdone",
            explicitSkip: false,
          },
        },
      })),
    });

    // Historical pilot feedback does not reopen the provider-derived ranking.
    await prisma.probableLikePilotFeedback.create({
      data: {
        userId: user.id,
        spotifyTrackId,
        trackName: "Quarantined Candidate",
        artistName: "Quarantined Artist",
        verdict: "LIKED",
        candidateScore: 50,
        candidateReasons: ["legacy-pilot-only"],
        evaluatedAt: new Date("2026-08-25T10:00:00.000Z"),
      },
    });

    const shadow = await getProbableLikeShadow(user.id, { limit: 25 });
    assert.deepEqual(shadow.candidates, []);
    assert.equal(shadow.evaluatedTrackCount, 0);

    let identityResolutionAttempted = false;
    let providerWriteAttempted = false;

    await assert.rejects(
      confirmProbableLike(
        { userId: user.id, spotifyTrackId },
        {
          resolveSpotifyIdentity: async () => {
            identityResolutionAttempted = true;
            throw new Error("identity resolution must remain unreachable");
          },
          saveTrackToSpotify: async () => {
            providerWriteAttempted = true;
            throw new Error("Spotify write must remain unreachable");
          },
        },
      ),
      ProbableLikeCandidateNotFoundError,
    );

    assert.equal(identityResolutionAttempted, false);
    assert.equal(providerWriteAttempted, false);
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
      await prisma.trackListeningEvent.count({
        where: { userId: user.id, spotifyTrackId },
      }),
      3,
    );
    assert.equal(
      await prisma.probableLikePilotFeedback.count({
        where: { userId: user.id, spotifyTrackId },
      }),
      1,
    );
  },
);
