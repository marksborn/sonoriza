import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { getProbableLikeShadow, type ProbableLikeShadowResult } from "./probable-like";
import {
  PROBABLE_LIKE_COOLDOWN_DAYS,
  ProbableLikeDismissalCandidateNotFoundError,
  applyProbableLikeCooldowns,
  dismissProbableLike,
} from "./probable-like-dismissal";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 5C Agora não cannot materialize a dismissal from quarantined provider history",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-dismiss-${suffix}@example.test` },
    });
    const spotifyTrackId = `dismiss-candidate-${suffix}`;

    t.after(async () => {
      await prisma.historyProbableLikeDismissal.deleteMany({
        where: { userId: user.id },
      });
      await prisma.trackListeningEvent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.trackListeningEvent.createMany({
      data: [20, 22, 24].map((day, index) => ({
        userId: user.id,
        spotifyTrackId,
        spotifyUri: `spotify:track:${spotifyTrackId}`,
        trackName: "Cooldown Candidate",
        artistName: "Cooldown Artist",
        playedAt: new Date(`2026-08-${day}T10:00:00.000Z`),
        source: "SPOTIFY_EXTENDED_HISTORY" as const,
        sourceEventKey: `cooldown-${index}-${suffix}`,
        metadata: {
          spotifyExtendedHistory: {
            msPlayed: 210_000,
            reasonEnd: "trackdone",
            explicitSkip: false,
          },
        },
      })),
    });

    const now = new Date("2026-08-29T20:00:00.000Z");
    const shadow = await getProbableLikeShadow(user.id, { now, limit: 10 });
    assert.deepEqual(shadow.candidates, []);

    await assert.rejects(
      dismissProbableLike({ userId: user.id, spotifyTrackId, now }),
      ProbableLikeDismissalCandidateNotFoundError,
    );

    assert.equal(
      await prisma.historyProbableLikeDismissal.count({
        where: { userId: user.id },
      }),
      0,
    );
  },
);

integrationTest(
  "stored Gate 6 cooldown still filters an admitted result and expires without preference side effects",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-cooldown-${suffix}@example.test` },
    });
    const spotifyTrackId = `stored-dismissal-${suffix}`;
    const now = new Date("2026-08-29T20:00:00.000Z");
    const suppressUntil = new Date(
      now.getTime() + PROBABLE_LIKE_COOLDOWN_DAYS * 86_400_000,
    );

    t.after(async () => {
      await prisma.historyProbableLikeDismissal.deleteMany({
        where: { userId: user.id },
      });
      await prisma.likedTrackPreference.deleteMany({ where: { userId: user.id } });
      await prisma.musicPreferenceSignal.deleteMany({ where: { userId: user.id } });
      await prisma.artistAffinityState.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.historyProbableLikeDismissal.create({
      data: {
        userId: user.id,
        spotifyTrackId,
        source: "PROBABLE_LIKE",
        trackName: "Cooldown Candidate",
        artistName: "Cooldown Artist",
        candidateScore: 42,
        candidateReasons: ["stored-gate6-fixture"],
        firstDismissedAt: now,
        lastDismissedAt: now,
        suppressUntil,
      },
    });

    const admitted: ProbableLikeShadowResult = {
      generatedAt: now,
      evaluatedTrackCount: 1,
      excludedLikedCount: 0,
      excludedStrongNegativeCount: 0,
      excludedShortContentCount: 0,
      candidates: [
        {
          spotifyTrackId,
          trackName: "Cooldown Candidate",
          artistName: "Cooldown Artist",
          playCount: 3,
          distinctDays: 3,
          factualCompleteCount: 3,
          factualSkipCount: 0,
          knownTrackDurationMs: 210_000,
          maxFactualCompleteMsPlayed: 210_000,
          inferredCompleteCount: 0,
          inferredSkipCount: 0,
          firstPlayedAt: new Date("2026-08-20T10:00:00.000Z"),
          lastPlayedAt: new Date("2026-08-24T10:00:00.000Z"),
          score: 42,
          reasons: ["stored-gate6-fixture"],
        },
      ],
    };

    const duringCooldown = await applyProbableLikeCooldowns(
      user.id,
      admitted,
      new Date(now.getTime() + 1),
    );
    assert.equal(duringCooldown.result.candidates.length, 0);
    assert.equal(duringCooldown.excludedCooldownCount, 1);

    const afterCooldown = await applyProbableLikeCooldowns(
      user.id,
      admitted,
      new Date(suppressUntil.getTime() + 1),
    );
    assert.equal(afterCooldown.result.candidates[0]?.spotifyTrackId, spotifyTrackId);
    assert.equal(afterCooldown.excludedCooldownCount, 0);

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
