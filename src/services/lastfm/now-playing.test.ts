import assert from "node:assert/strict";
import test from "node:test";

import { LastFmClient } from "./client";

test("HISTORY-01 excludes now-playing rows even when Last.fm sends date.uts", async () => {
  const client = new LastFmClient({
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          recenttracks: {
            track: [
              {
                name: "Current",
                artist: { name: "Artist" },
                "@attr": { nowplaying: "true" },
                date: { uts: "1770000001" },
              },
              {
                name: "Completed",
                artist: { name: "Artist" },
                date: { uts: "1770000000" },
              },
            ],
            "@attr": {
              user: "marks",
              page: "1",
              perPage: "200",
              totalPages: "1",
              total: "2",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const page = await client.getRecentTracksPage({ username: "marks" });

  assert.equal(page.nowPlayingCount, 1);
  assert.equal(page.invalidCount, 0);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0]?.trackName, "Completed");
});
