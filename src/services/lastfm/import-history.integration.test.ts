import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { importLastFmHistory } from "./import-history";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Last.fm backfill stops before the earliest Spotify history event and persists scrobbles idempotently",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `lastfm-history-${suffix}@example.test` },
    });
    const spotifyHandoff = new Date("2026-08-12T20:00:00.000Z");
    await prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        spotifyTrackId: "spotify-track",
        spotifyUri: "spotify:track:spotify-track",
        trackName: "Spotify Track",
        artistName: "Spotify Artist",
        playedAt: spotifyHandoff,
        source: "SPOTIFY_RECENTLY_PLAYED",
        sourceEventKey: `spotify-test-${suffix}`,
      },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    const recentRequests: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const method = url.searchParams.get("method");
      if (method === "user.getinfo") {
        return new Response(
          JSON.stringify({
            user: {
              name: "marks",
              playcount: "2",
              registered: { unixtime: "1325376000" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "user.getrecenttracks") {
        recentRequests.push(url);
        return new Response(
          JSON.stringify({
            recenttracks: {
              track: [
                {
                  name: "Old Track",
                  artist: { name: "Old Artist", mbid: "artist-mbid" },
                  album: { "#text": "Old Album" },
                  date: { uts: "1700000000" },
                },
              ],
              "@attr": {
                user: "marks",
                page: "1",
                perPage: "200",
                totalPages: "1",
                total: "1",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected Last.fm method ${method}`);
    }) as typeof fetch;

    try {
      const result = await importLastFmHistory({
        userId: user.id,
        username: "marks",
        apiKey: "test-key",
      });

      assert.equal(result.status, "SUCCESS");
      assert.equal(result.insertedEvents, 1);
      assert.equal(result.duplicateEvents, 0);
      assert.equal(result.lastFmHistoryUntil.toISOString(), spotifyHandoff.toISOString());
      assert.equal(recentRequests.length, 1);
      assert.equal(
        recentRequests[0]?.searchParams.get("to"),
        String(Math.floor(spotifyHandoff.getTime() / 1000)),
      );

      const events = await prisma.trackListeningEvent.findMany({
        where: { userId: user.id },
        orderBy: { playedAt: "asc" },
      });
      assert.equal(events.length, 2);
      assert.equal(events[0]?.source, "LASTFM_SCROBBLE");
      assert.equal(events[1]?.source, "SPOTIFY_RECENTLY_PLAYED");

      // Explicitly retry the completed provider row through a fresh bounded run.
      const repeated = await importLastFmHistory({
        userId: user.id,
        username: "marks",
        apiKey: "test-key",
        to: spotifyHandoff,
      });
      assert.equal(repeated.insertedEvents, 0);
      assert.equal(repeated.duplicateEvents, 1);
      assert.equal(
        await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
        2,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
