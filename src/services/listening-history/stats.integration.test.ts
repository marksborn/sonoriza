import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { getListeningHistoryStats } from "./stats";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "aggregates Gate 2 statistics from the canonical filtered timeline without inventing listening time",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `history-stats-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.lastFmBackfillRun.create({
      data: {
        userId: user.id,
        username: `stats-${suffix}`,
        status: "SUCCESS",
        from: new Date("2013-11-12T12:17:22.000Z"),
        to: new Date("2020-01-01T00:00:00.000Z"),
        finishedAt: new Date("2020-01-01T00:00:01.000Z"),
      },
    });

    await prisma.trackListeningEvent.createMany({
      data: [
        {
          userId: user.id,
          trackName: "Synthetic",
          artistName: "Ghost Artist",
          albumName: "Ghost Album",
          playedAt: new Date("1970-01-01T00:00:01.000Z"),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: `synthetic-${suffix}`,
        },
        {
          userId: user.id,
          trackName: "Track A",
          artistName: "Artist A",
          albumName: "Album One",
          playedAt: new Date("2015-01-01T12:00:00.000Z"),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: `a-1-${suffix}`,
          metadata: { spotifyExtendedHistory: { msPlayed: 60_000 } },
        },
        {
          userId: user.id,
          trackName: "track a",
          artistName: "artist a",
          albumName: "Album One",
          playedAt: new Date("2016-01-01T12:00:00.000Z"),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: `a-2-${suffix}`,
        },
        {
          userId: user.id,
          spotifyTrackId: "spotify-a",
          trackName: "Track A",
          artistName: "Artist A",
          albumName: "Album One",
          playedAt: new Date("2026-08-20T10:00:00.000Z"),
          source: "SPOTIFY_RECENTLY_PLAYED",
          sourceEventKey: `a-3-${suffix}`,
          metadata: { spotifyExtendedHistory: { msPlayed: 120_000 } },
        },
        {
          userId: user.id,
          spotifyTrackId: "spotify-b",
          trackName: "Track B",
          artistName: "Artist B",
          albumName: "Album Two",
          playedAt: new Date("2026-08-21T10:00:00.000Z"),
          source: "SPOTIFY_RECENTLY_PLAYED",
          sourceEventKey: `b-1-${suffix}`,
        },
        {
          userId: user.id,
          spotifyTrackId: "spotify-b",
          trackName: "Track B",
          artistName: "Artist B",
          albumName: "Album Two",
          playedAt: new Date("2026-08-22T10:00:00.000Z"),
          source: "SPOTIFY_EXTENDED_HISTORY",
          sourceEventKey: `b-2-${suffix}`,
          metadata: { spotifyExtendedHistory: { msPlayed: 180_000 } },
        },
        {
          userId: user.id,
          spotifyTrackId: "spotify-c",
          trackName: "Track C",
          artistName: "Artist A",
          albumName: "Album Three",
          playedAt: new Date("2026-08-23T10:00:00.000Z"),
          source: "SPOTIFY_EXTENDED_HISTORY",
          sourceEventKey: `c-1-${suffix}`,
          metadata: { spotifyExtendedHistory: { msPlayed: 240_000 } },
        },
      ],
    });

    const all = await getListeningHistoryStats(user.id, {
      from: null,
      toExclusive: null,
      query: "",
      source: null,
    });

    assert.equal(all.playCount, 6);
    assert.equal(all.distinctTracks, 3);
    assert.equal(all.distinctArtists, 2);
    assert.equal(all.distinctAlbums, 3);
    assert.equal(all.measuredPlayEvents, 4);
    assert.equal(all.measuredListeningMs, 600_000);
    assert.equal(all.measuredCoveragePercent, 66.7);
    assert.deepEqual(all.topTracks, [
      { trackName: "Track A", artistName: "Artist A", playCount: 3 },
      { trackName: "Track B", artistName: "Artist B", playCount: 2 },
      { trackName: "Track C", artistName: "Artist A", playCount: 1 },
    ]);
    assert.deepEqual(all.topArtists, [
      { artistName: "Artist A", playCount: 4 },
      { artistName: "Artist B", playCount: 2 },
    ]);
    assert.deepEqual(all.topAlbums, [
      { albumName: "Album One", artistName: "Artist A", playCount: 3 },
      { albumName: "Album Two", artistName: "Artist B", playCount: 2 },
      { albumName: "Album Three", artistName: "Artist A", playCount: 1 },
    ]);

    const trackB = await getListeningHistoryStats(user.id, {
      from: null,
      toExclusive: null,
      query: "Track B",
      source: null,
    });
    assert.equal(trackB.playCount, 2);
    assert.equal(trackB.distinctTracks, 1);
    assert.equal(trackB.distinctArtists, 1);
    assert.equal(trackB.distinctAlbums, 1);
    assert.equal(trackB.measuredPlayEvents, 1);
    assert.equal(trackB.measuredListeningMs, 180_000);
    assert.equal(trackB.measuredCoveragePercent, 50);

    const extendedOnly = await getListeningHistoryStats(user.id, {
      from: null,
      toExclusive: null,
      query: "",
      source: "SPOTIFY_EXTENDED_HISTORY",
    });
    assert.equal(extendedOnly.playCount, 2);
    assert.equal(extendedOnly.measuredPlayEvents, 2);
    assert.equal(extendedOnly.measuredListeningMs, 420_000);
  },
);
