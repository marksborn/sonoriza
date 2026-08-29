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
  "persists Gate 4 pilot verdicts without creating canonical preference side effects",
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
    const dates = [
      "2026-08-20T10:00:00.000Z",
      "2026-08-22T10:00:00.000Z",
      "2026-08-24T10:00:00.000Z",
    ];

    await prisma.trackListeningEvent.createMany({
      data: dates.map((playedAt, index) => ({
        userId: user.id,
        spotifyTrackId: candidateId,
        spotifyUri: `spotify:track:${candidateId}`,
        trackName: "Pilot Candidate",
        artistName: "Pilot Artist",
        playedAt: new Date(playedAt),
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

    const first = await recordProbableLikePilotFeedback({
      userId: user.id,
      spotifyTrackId: candidateId,
      verdict: "LIKED",
    });
    assert.equal(first.verdict, "LIKED");
    assert.equal(first.trackName, "Pilot Candidate");
    assert.ok(first.candidateScore > 0);

    let summary = await getProbableLikePilotSummary(user.id);
    assert.equal(summary.evaluatedCount, 1);
    assert.equal(summary.likedCount, 1);
    assert.equal(summary.indifferentCount, 0);
    assert.equal(summary.dislikedCount, 0);
    assert.equal(summary.precisionPercent, 100);
    assert.equal(summary.feedbackByTrackId[candidateId]?.verdict, "LIKED");

    const changed = await recordProbableLikePilotFeedback({
      userId: user.id,
      spotifyTrackId: candidateId,
      verdict: "INDIFFERENT",
    });
    assert.equal(changed.verdict, "INDIFFERENT");
    assert.equal(
      await prisma.probableLikePilotFeedback.count({
        where: { userId: user.id, spotifyTrackId: candidateId },
      }),
      1,
    );

    summary = await getProbableLikePilotSummary(user.id);
    assert.equal(summary.evaluatedCount, 1);
    assert.equal(summary.likedCount, 0);
    assert.equal(summary.indifferentCount, 1);
    assert.equal(summary.precisionPercent, 0);

    // Gate 4 is measurement only: it must not leak into any productive
    // preference surface that Gate 5+ will own.
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

    await assert.rejects(
      () =>
        recordProbableLikePilotFeedback({
          userId: user.id,
          spotifyTrackId: "not-a-current-candidate",
          verdict: "DISLIKED",
        }),
      ProbableLikePilotCandidateNotFoundError,
    );
  },
);
