import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { getListeningHistoryStats } from "./stats";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 5C keeps provider listening rows out of HISTORY-04 analytics SQL",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `history-stats-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.trackListeningEvent.createMany({
      data: [
        {
          userId: user.id,
          spotifyTrackId: "spotify-a",
          trackName: "Track A",
          artistName: "Artist A",
          albumName: "Album One",
          playedAt: new Date("2026-08-20T10:00:00.000Z"),
          source: "SPOTIFY_RECENTLY_PLAYED",
          sourceEventKey: `a-${suffix}`,
          metadata: { spotifyExtendedHistory: { msPlayed: 120_000 } },
        },
        {
          userId: user.id,
          trackName: "Track B",
          artistName: "Artist B",
          albumName: "Album Two",
          playedAt: new Date("2016-01-01T12:00:00.000Z"),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: `b-${suffix}`,
        },
      ],
    });

    const all = await getListeningHistoryStats(user.id, {
      from: null,
      toExclusive: null,
      query: "",
      source: null,
    });

    assert.equal(all.policy.status, "QUARANTINED");
    assert.deepEqual(all.policy.allowedSources, []);
    assert.equal(all.playCount, 0);
    assert.equal(all.distinctTracks, 0);
    assert.equal(all.distinctArtists, 0);
    assert.equal(all.distinctAlbums, 0);
    assert.equal(all.measuredPlayEvents, 0);
    assert.equal(all.measuredListeningMs, 0);
    assert.equal(all.measuredCoveragePercent, 0);
    assert.deepEqual(all.topTracks, []);
    assert.deepEqual(all.topArtists, []);
    assert.deepEqual(all.topAlbums, []);

    const filtered = await getListeningHistoryStats(user.id, {
      from: null,
      toExclusive: null,
      query: "Track A",
      source: "SPOTIFY_RECENTLY_PLAYED",
    });
    assert.equal(filtered.policy.status, "QUARANTINED");
    assert.equal(filtered.playCount, 0);
  },
);
