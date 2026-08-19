import assert from "node:assert/strict";
import test from "node:test";

import { scanLastFmBackfill } from "./backfill";
import { LastFmClient } from "./client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("HISTORY-01 rejects Last.fm rows outside the frozen account history window", async () => {
  const registeredAt = new Date("2013-11-12T12:17:22.000Z");
  const frozenTo = new Date("2026-08-14T09:48:54.000Z");

  const client = new LastFmClient({
    apiKey: "test-key",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const method = url.searchParams.get("method");

      if (method === "user.getinfo") {
        return jsonResponse({
          user: {
            name: "marksborn",
            playcount: "4",
            registered: {
              unixtime: String(Math.floor(registeredAt.getTime() / 1000)),
            },
          },
        });
      }

      if (method !== "user.getrecenttracks") {
        throw new Error(`unexpected ${method}`);
      }

      return jsonResponse({
        recenttracks: {
          track: [
            {
              name: "Synthetic 1970",
              artist: { name: "Invalid" },
              date: { uts: "1" },
            },
            {
              name: "At Registration Boundary",
              artist: { name: "Valid" },
              date: {
                uts: String(Math.floor(registeredAt.getTime() / 1000)),
              },
            },
            {
              name: "Inside Window",
              artist: { name: "Valid" },
              date: { uts: "1700000000" },
            },
            {
              name: "At Exclusive Upper Boundary",
              artist: { name: "Invalid" },
              date: { uts: String(Math.floor(frozenTo.getTime() / 1000)) },
            },
          ],
          "@attr": {
            user: "marksborn",
            page: "1",
            perPage: "200",
            totalPages: "1",
            total: "4",
          },
        },
      });
    },
  });

  let persistedEvents: string[] = [];
  const result = await scanLastFmBackfill({
    client,
    username: "marksborn",
    to: frozenTo,
    onPage(page) {
      persistedEvents = page.events.map((event) => event.trackName);
    },
  });

  assert.deepEqual(persistedEvents, [
    "At Registration Boundary",
    "Inside Window",
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.checkpoint.scannedProviderRows, 4);
  assert.equal(result.checkpoint.acceptedEvents, 2);
  assert.equal(result.checkpoint.invalidSkipped, 2);
});
