import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  ProbableLikePilotCandidateNotFoundError,
  getProbableLikePilotSummary,
  recordProbableLikePilotFeedback,
} from "./probable-like-pilot";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 5C cannot create pilot feedback from a quarantined provider-derived ranking",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-pilot-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.probableLikePilotFeedback.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
    });

    const candidateId = `pilot-candidate-${suffix}`;
    await prisma.trackListeningEvent.createMany({
      data: [0, 1, 2].map((index) => ({
        userId: user.id,
        spotifyTrackId: candidateId,
        spotifyUri: `spotify:track:${candidateId}`,
        trackName: "Pilot Candidate",
        artistName: "Pilot Artist",
        playedAt: new Date(`2026-08-${20 + index * 2}T10:00:00.000Z`),
        source: "SPOTIFY_EXTENDED_HISTORY" as const,
        sourceEventKey: `pilot-${index}-${suffix}`,
        metadata: {
          spotifyExtendedHistory: {
            msPlayed: 190_000,
            reasonEnd: "trackdone",
            explicitSkip: false,
          },
        },
      })),
    });

    await assert.rejects(
      () =>
        recordProbableLikePilotFeedback({
          userId: user.id,
          spotifyTrackId: candidateId,
          verdict: "LIKED",
        }),
      ProbableLikePilotCandidateNotFoundError,
    );

    assert.equal(
      await prisma.probableLikePilotFeedback.count({ where: { userId: user.id } }),
      0,
    );

    const summary = await getProbableLikePilotSummary(user.id);
    assert.equal(summary.evaluatedCount, 0);
    assert.equal(summary.precisionPercent, 0);

    assert.equal(
      await prisma.likedTrackPreference.count({ where: { userId: user.id } }),
      0,
    );
    assert.equal(
      await prisma.musicPreferenceSignal.count({ where: { userId: user.id } }),
      0,
    );
    assert.equal(
      await prisma.artistAffinityState.count({ where: { userId: user.id } }),
      0,
    );
  },
);
