import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { confirmProbableLike } from "./probable-like-action";
import { getProbableLikeShadow } from "./probable-like";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 5 confirms one canonical LIKE, propagates artist affinity and removes the candidate idempotently",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-action-${suffix}@example.test` },
    });
    const spotifyTrackId = `gate5-track-${suffix}`;
    const spotifyArtistId = `gate5-artist-${suffix}`;

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

    const first = await confirmProbableLike({
      userId: user.id,
      spotifyTrackId,
    });
    assert.equal(first.spotifyTrackId, spotifyTrackId);
    assert.equal(first.alreadyLiked, false);
    assert.equal(first.artistAffinityUpdated, true);
    assert.equal(first.providerWriteAttempted, false);
    assert.equal(first.providerWriteReason, "USER_LIBRARY_MODIFY_SCOPE_NOT_ENABLED");

    const preference = await prisma.likedTrackPreference.findUniqueOrThrow({
      where: { userId_spotifyTrackId: { userId: user.id, spotifyTrackId } },
    });
    assert.equal(preference.isLiked, true);
    assert.equal(preference.trackName, "Gate 5 Candidate");
    assert.equal(preference.primaryArtistId, spotifyArtistId);
    assert.equal(preference.firstProvenance, "LIKED_TRACK_SYNC");
    assert.equal(preference.lastProvenance, "LIKED_TRACK_SYNC");

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
    assert.equal(action.providerWriteAttempted, false);
    assert.equal(action.confirmCount, 1);

    const after = await getProbableLikeShadow(user.id, { limit: 25 });
    assert.equal(
      after.candidates.some((item) => item.spotifyTrackId === spotifyTrackId),
      false,
    );

    // A retry/double click is idempotent and does not duplicate preference,
    // affinity evidence, action provenance, or artist weight.
    const retry = await confirmProbableLike({ userId: user.id, spotifyTrackId });
    assert.equal(retry.alreadyLiked, true);
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
    const affinityAfterRetry = await prisma.artistAffinityState.findUniqueOrThrow({
      where: {
        userId_spotifyArtistId: {
          userId: user.id,
          spotifyArtistId,
        },
      },
    });
    assert.equal(affinityAfterRetry.likedTrackCount, 1);

    const pilotFeedback = await prisma.probableLikePilotFeedback.findUniqueOrThrow({
      where: { userId_spotifyTrackId: { userId: user.id, spotifyTrackId } },
    });
    assert.equal(pilotFeedback.verdict, "LIKED");
  },
);
