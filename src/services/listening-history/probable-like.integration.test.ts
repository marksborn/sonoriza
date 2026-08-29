import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { getProbableLikeShadow } from "./probable-like";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "builds probable-like shadow ranking from canonical factual and inferred evidence",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `probable-like-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.lastFmBackfillRun.create({
      data: {
        userId: user.id,
        username: `probable-${suffix}`,
        status: "SUCCESS",
        from: new Date("2013-11-12T12:17:22.000Z"),
        to: new Date("2020-01-01T00:00:00.000Z"),
        finishedAt: new Date("2020-01-01T00:00:01.000Z"),
      },
    });

    const factualEvents = [
      "2026-08-01T10:00:00.000Z",
      "2026-08-05T10:00:00.000Z",
      "2026-08-10T10:00:00.000Z",
      "2026-08-15T10:00:00.000Z",
    ].map((playedAt, index) => ({
      userId: user.id,
      spotifyTrackId: "factual-candidate",
      spotifyUri: "spotify:track:factual-candidate",
      trackName: "Factual Candidate",
      artistName: "Artist Factual",
      playedAt: new Date(playedAt),
      source: "SPOTIFY_EXTENDED_HISTORY" as const,
      sourceEventKey: `factual-${index}-${suffix}`,
      metadata: {
        spotifyExtendedHistory: {
          msPlayed: 180_000,
          reasonEnd: "trackdone",
          explicitSkip: false,
        },
      },
    }));

    const inferredEvents = [
      "2026-08-20T10:00:00.000Z",
      "2026-08-22T10:00:00.000Z",
      "2026-08-24T10:00:00.000Z",
    ].flatMap((playedAt, index) => {
      const start = new Date(playedAt);
      const anchor = new Date(start.getTime() + 178_000);
      return [
        {
          userId: user.id,
          spotifyTrackId: "inferred-candidate",
          spotifyUri: "spotify:track:inferred-candidate",
          trackName: "Inferred Candidate",
          artistName: "Artist Inferred",
          playedAt: start,
          source: "SPOTIFY_RECENTLY_PLAYED" as const,
          sourceEventKey: `inferred-${index}-${suffix}`,
          metadata: {
            spotifyRecentlyPlayed: { trackDurationMs: 180_000 },
          },
        },
        {
          userId: user.id,
          spotifyTrackId: `anchor-${index}`,
          spotifyUri: `spotify:track:anchor-${index}`,
          trackName: `Anchor ${index}`,
          artistName: "Anchor Artist",
          playedAt: anchor,
          source: "SPOTIFY_RECENTLY_PLAYED" as const,
          sourceEventKey: `anchor-${index}-${suffix}`,
        },
      ];
    });

    const likedEvents = [0, 1, 2].map((index) => ({
      userId: user.id,
      spotifyTrackId: "already-liked",
      spotifyUri: "spotify:track:already-liked",
      trackName: "Already Liked",
      artistName: "Liked Artist",
      playedAt: new Date(`2026-08-${String(index + 2).padStart(2, "0")}T12:00:00.000Z`),
      source: "SPOTIFY_EXTENDED_HISTORY" as const,
      sourceEventKey: `liked-${index}-${suffix}`,
      metadata: {
        spotifyExtendedHistory: {
          msPlayed: 200_000,
          reasonEnd: "trackdone",
          explicitSkip: false,
        },
      },
    }));

    const shortUtilityEvents = [0, 1, 2, 3].map((index) => ({
      userId: user.id,
      spotifyTrackId: "short-utility",
      spotifyUri: "spotify:track:short-utility",
      trackName: "Utility Day Marker",
      artistName: "Provider Utility",
      playedAt: new Date(`2022-11-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
      source: "SPOTIFY_EXTENDED_HISTORY" as const,
      sourceEventKey: `short-${index}-${suffix}`,
      metadata: {
        spotifyExtendedHistory: {
          msPlayed: 6_000,
          reasonEnd: "trackdone",
          explicitSkip: false,
        },
      },
    }));

    await prisma.trackListeningEvent.createMany({
      data: [
        {
          userId: user.id,
          spotifyTrackId: "ghost-before-window",
          trackName: "Ghost",
          artistName: "Ghost Artist",
          playedAt: new Date("1970-01-01T00:00:01.000Z"),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: `ghost-${suffix}`,
        },
        ...factualEvents,
        ...inferredEvents,
        ...likedEvents,
        ...shortUtilityEvents,
      ],
    });

    await prisma.likedTrackPreference.create({
      data: {
        userId: user.id,
        spotifyTrackId: "already-liked",
        spotifyUri: "spotify:track:already-liked",
        trackName: "Already Liked",
        isLiked: true,
        availability: "AVAILABLE",
        firstProvenance: "LIKED_TRACK_SYNC",
        lastProvenance: "LIKED_TRACK_SYNC",
        lastObservedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    });

    const result = await getProbableLikeShadow(user.id, {
      now: new Date("2026-08-29T12:00:00.000Z"),
      limit: 10,
    });

    const ids = result.candidates.map((candidate) => candidate.spotifyTrackId);
    assert.ok(ids.includes("factual-candidate"));
    assert.ok(ids.includes("inferred-candidate"));
    assert.ok(!ids.includes("already-liked"));
    assert.ok(!ids.includes("ghost-before-window"));
    assert.ok(!ids.includes("short-utility"));
    assert.equal(result.excludedLikedCount, 1);
    assert.equal(result.excludedShortContentCount, 1);

    const factual = result.candidates.find(
      (candidate) => candidate.spotifyTrackId === "factual-candidate",
    );
    assert.ok(factual);
    assert.equal(factual.factualCompleteCount, 4);
    assert.equal(factual.inferredCompleteCount, 0);

    const inferred = result.candidates.find(
      (candidate) => candidate.spotifyTrackId === "inferred-candidate",
    );
    assert.ok(inferred);
    assert.equal(inferred.factualCompleteCount, 0);
    assert.equal(inferred.inferredCompleteCount, 3);
    assert.ok(
      inferred.reasons.some((reason) => reason.includes("conclusões inferidas")),
    );
  },
);