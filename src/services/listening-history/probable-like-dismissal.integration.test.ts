import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { getProbableLikeShadow } from "./probable-like";
import {
  PROBABLE_LIKE_COOLDOWN_DAYS,
  applyProbableLikeCooldowns,
  dismissProbableLike,
} from "./probable-like-dismissal";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 6 Agora não suppresses temporarily without creating dislike or LIKE side effects",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-dismiss-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.historyProbableLikeDismissal.deleteMany({
        where: { userId: user.id },
      });
      await prisma.trackListeningEvent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    const spotifyTrackId = `dismiss-candidate-${suffix}`;
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
        trackName: "Cooldown Candidate",
        artistName: "Cooldown Artist",
        playedAt: new Date(playedAt),
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
    assert.equal(shadow.candidates[0]?.spotifyTrackId, spotifyTrackId);

    const dismissal = await dismissProbableLike({
      userId: user.id,
      spotifyTrackId,
      now,
    });
    assert.equal(dismissal.dismissCount, 1);
    assert.equal(
      dismissal.suppressUntil.getTime(),
      now.getTime() + PROBABLE_LIKE_COOLDOWN_DAYS * 86_400_000,
    );

    const duringCooldown = await applyProbableLikeCooldowns(
      user.id,
      shadow,
      new Date(now.getTime() + 1),
    );
    assert.equal(duringCooldown.result.candidates.length, 0);
    assert.equal(duringCooldown.excludedCooldownCount, 1);

    const afterCooldown = await applyProbableLikeCooldowns(
      user.id,
      shadow,
      new Date(dismissal.suppressUntil.getTime() + 1),
    );
    assert.equal(afterCooldown.result.candidates[0]?.spotifyTrackId, spotifyTrackId);
    assert.equal(afterCooldown.excludedCooldownCount, 0);

    // Gate 6 is a light rejection only. It must not masquerade as any durable
    // preference signal or artist-affinity mutation.
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
