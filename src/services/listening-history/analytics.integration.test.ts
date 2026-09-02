import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  getListeningHistorySummary,
  getTrackListeningStats,
} from "./analytics";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 5C preserves backfill status but quarantines provider-derived listening metrics",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `history-analytics-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.lastFmBackfillRun.create({
      data: {
        userId: user.id,
        username: `analytics-${suffix}`,
        status: "SUCCESS",
        from: new Date("2013-11-12T12:17:22.000Z"),
        to: new Date("2020-01-01T00:00:00.000Z"),
        acceptedEvents: 2,
        insertedEvents: 2,
        duplicateEvents: 0,
        finishedAt: new Date("2020-01-01T00:00:01.000Z"),
      },
    });

    await prisma.trackListeningEvent.createMany({
      data: [
        {
          userId: user.id,
          trackName: "Track A",
          artistName: "Artist A",
          albumName: "Album A",
          playedAt: new Date("2015-01-01T12:00:00.000Z"),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: `lastfm-${suffix}`,
        },
        {
          userId: user.id,
          spotifyTrackId: "spotify-a",
          spotifyUri: "spotify:track:spotify-a",
          trackName: "Track A",
          artistName: "Artist A",
          albumName: "Album A",
          playedAt: new Date("2026-08-12T20:00:00.000Z"),
          source: "SPOTIFY_RECENTLY_PLAYED",
          sourceEventKey: `spotify-${suffix}`,
        },
      ],
    });

    const track = await getTrackListeningStats(user.id, {
      spotifyTrackId: "spotify-a",
      trackName: "Track A",
      artistName: "Artist A",
      albumName: "Album A",
    });
    assert.equal(track.identityBasis, "SPOTIFY_ID");
    assert.equal(track.playCount, 0);
    assert.equal(track.firstPlayedAt, null);
    assert.equal(track.lastPlayedAt, null);
    assert.deepEqual(track.sources, []);
    assert.equal(track.unresolvedHistoricalCandidates.count, 0);

    const unresolved = await getTrackListeningStats(user.id, {
      trackName: "Track A",
      artistName: "Artist A",
      albumName: "Album A",
    });
    assert.equal(unresolved.identityBasis, "UNRESOLVED_NAME");
    assert.equal(unresolved.playCount, 0);

    const summary = await getListeningHistorySummary(user.id);
    assert.equal(summary.totalPlayEvents, 0);
    assert.equal(summary.firstPlayedAt, null);
    assert.equal(summary.lastPlayedAt, null);
    assert.deepEqual(summary.sources, []);
    assert.equal(summary.lastFmBackfill?.status, "SUCCESS");
    assert.equal(summary.lastFmBackfill?.acceptedEvents, 2);
  },
);
