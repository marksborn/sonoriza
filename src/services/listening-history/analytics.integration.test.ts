import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  getListeningHistorySummary,
  getTrackListeningStats,
} from "./analytics";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "derives confirmed play count while keeping unresolved Last.fm identity candidates separate",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `history-analytics-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
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
          sourceEventKey: `lastfm-1-${suffix}`,
        },
        {
          userId: user.id,
          trackName: "track a",
          artistName: "artist a",
          albumName: "album a",
          playedAt: new Date("2018-01-01T12:00:00.000Z"),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: `lastfm-2-${suffix}`,
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
          sourceEventKey: `spotify-1-${suffix}`,
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
    assert.equal(track.playCount, 1);
    assert.equal(track.firstPlayedAt?.toISOString(), "2026-08-12T20:00:00.000Z");
    assert.equal(track.lastPlayedAt?.toISOString(), "2026-08-12T20:00:00.000Z");
    assert.deepEqual(track.sources, [
      { source: "SPOTIFY_RECENTLY_PLAYED", count: 1 },
    ]);
    assert.equal(track.unresolvedHistoricalCandidates.count, 2);
    assert.equal(
      track.unresolvedHistoricalCandidates.firstPlayedAt?.toISOString(),
      "2015-01-01T12:00:00.000Z",
    );
    assert.equal(
      track.unresolvedHistoricalCandidates.lastPlayedAt?.toISOString(),
      "2018-01-01T12:00:00.000Z",
    );

    const unresolved = await getTrackListeningStats(user.id, {
      trackName: "Track A",
      artistName: "Artist A",
      albumName: "Album A",
    });
    assert.equal(unresolved.identityBasis, "UNRESOLVED_NAME");
    assert.equal(unresolved.playCount, 2);
    assert.equal(unresolved.unresolvedHistoricalCandidates.count, 0);

    const summary = await getListeningHistorySummary(user.id);
    assert.equal(summary.totalPlayEvents, 3);
    assert.equal(summary.firstPlayedAt?.toISOString(), "2015-01-01T12:00:00.000Z");
    assert.equal(summary.lastPlayedAt?.toISOString(), "2026-08-12T20:00:00.000Z");
  },
);
