import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { getProbableLikeShadow } from "./probable-like";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 5C returns no probable-like ranking from provider listening history",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.trackListeningEvent.createMany({
      data: [
        {
          userId: user.id,
          spotifyTrackId: "candidate",
          spotifyUri: "spotify:track:candidate",
          trackName: "Candidate",
          artistName: "Artist",
          playedAt: new Date("2026-08-01T10:00:00.000Z"),
          source: "SPOTIFY_EXTENDED_HISTORY",
          sourceEventKey: `candidate-1-${suffix}`,
          metadata: {
            spotifyExtendedHistory: {
              msPlayed: 180_000,
              reasonEnd: "trackdone",
              explicitSkip: false,
            },
          },
        },
        {
          userId: user.id,
          spotifyTrackId: "candidate",
          spotifyUri: "spotify:track:candidate",
          trackName: "Candidate",
          artistName: "Artist",
          playedAt: new Date("2026-08-05T10:00:00.000Z"),
          source: "SPOTIFY_EXTENDED_HISTORY",
          sourceEventKey: `candidate-2-${suffix}`,
          metadata: {
            spotifyExtendedHistory: {
              msPlayed: 180_000,
              reasonEnd: "trackdone",
              explicitSkip: false,
            },
          },
        },
        {
          userId: user.id,
          spotifyTrackId: "candidate",
          spotifyUri: "spotify:track:candidate",
          trackName: "Candidate",
          artistName: "Artist",
          playedAt: new Date("2026-08-10T10:00:00.000Z"),
          source: "SPOTIFY_EXTENDED_HISTORY",
          sourceEventKey: `candidate-3-${suffix}`,
          metadata: {
            spotifyExtendedHistory: {
              msPlayed: 180_000,
              reasonEnd: "trackdone",
              explicitSkip: false,
            },
          },
        },
      ],
    });

    const result = await getProbableLikeShadow(user.id, {
      now: new Date("2026-08-29T12:00:00.000Z"),
      limit: 10,
    });

    assert.deepEqual(result.candidates, []);
    assert.equal(result.evaluatedTrackCount, 0);
    assert.equal(result.excludedLikedCount, 0);
    assert.equal(result.excludedStrongNegativeCount, 0);
    assert.equal(result.excludedShortContentCount, 0);
  },
);
