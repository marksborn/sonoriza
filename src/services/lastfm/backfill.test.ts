import assert from "node:assert/strict";
import test from "node:test";

import { LastFmClient } from "./client";
import { scanLastFmBackfill, type LastFmBackfillCheckpoint } from "./backfill";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientWithPages(requested: string[]) {
  return new LastFmClient({
    apiKey: "test-key",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const method = url.searchParams.get("method");
      if (method === "user.getinfo") {
        return jsonResponse({
          user: {
            name: "marks",
            playcount: "3",
            registered: { unixtime: "1325376000" },
          },
        });
      }
      if (method !== "user.getrecenttracks") throw new Error(`unexpected ${method}`);
      const page = Number(url.searchParams.get("page"));
      requested.push(url.toString());
      return jsonResponse({
        recenttracks: {
          track: [
            {
              name: `Track ${page}`,
              artist: { name: "Artist" },
              date: { uts: String(1770000000 - page) },
            },
          ],
          "@attr": {
            user: "marks",
            page: String(page),
            perPage: "200",
            totalPages: "3",
            total: "3",
          },
        },
      });
    },
  });
}

test("freezes the upper boundary and advances a checkpoint only after each page callback", async () => {
  const requested: string[] = [];
  const persisted: LastFmBackfillCheckpoint[] = [];
  const frozenTo = new Date("2026-08-12T23:00:00.000Z");

  const result = await scanLastFmBackfill({
    client: clientWithPages(requested),
    username: "marks",
    to: frozenTo,
    maxPages: 2,
    async onPage(page) {
      persisted.push(page.checkpointAfter);
    },
  });

  assert.equal(result.completed, false);
  assert.equal(result.checkpoint.nextPage, 3);
  assert.equal(result.checkpoint.totalPages, 3);
  assert.equal(result.checkpoint.acceptedEvents, 2);
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0]?.nextPage, 2);
  assert.equal(persisted[1]?.nextPage, 3);

  const expectedTo = String(Math.floor(frozenTo.getTime() / 1000));
  for (const value of requested) {
    const url = new URL(value);
    assert.equal(url.searchParams.get("to"), expectedTo);
    assert.equal(url.searchParams.get("limit"), "200");
    assert.equal(url.searchParams.get("from"), "1325376000");
  }
});

test("resumes from a persisted checkpoint without rescanning older completed pages", async () => {
  const requested: string[] = [];
  const checkpoint: LastFmBackfillCheckpoint = {
    username: "marks",
    from: new Date("2012-01-01T00:00:00.000Z"),
    to: new Date("2026-08-12T23:00:00.000Z"),
    nextPage: 3,
    totalPages: 3,
    scannedProviderRows: 2,
    acceptedEvents: 2,
    nowPlayingSkipped: 0,
    invalidSkipped: 0,
  };

  const result = await scanLastFmBackfill({
    client: clientWithPages(requested),
    username: "marks",
    checkpoint,
    onPage() {},
  });

  assert.equal(result.completed, true);
  assert.equal(result.checkpoint.nextPage, 4);
  assert.equal(result.checkpoint.acceptedEvents, 3);
  assert.deepEqual(
    requested.map((value) => new URL(value).searchParams.get("page")),
    ["3"],
  );
});

test("does not advance checkpoint when persistence callback fails", async () => {
  const requested: string[] = [];
  await assert.rejects(
    scanLastFmBackfill({
      client: clientWithPages(requested),
      username: "marks",
      maxPages: 1,
      async onPage() {
        throw new Error("database unavailable");
      },
    }),
    /database unavailable/,
  );

  assert.equal(requested.length, 1);
});

test("rejects a checkpoint from another Last.fm account", async () => {
  const requested: string[] = [];
  await assert.rejects(
    scanLastFmBackfill({
      client: clientWithPages(requested),
      username: "marks",
      checkpoint: {
        username: "someone-else",
        from: null,
        to: new Date("2026-08-12T23:00:00.000Z"),
        nextPage: 1,
        totalPages: null,
        scannedProviderRows: 0,
        acceptedEvents: 0,
        nowPlayingSkipped: 0,
        invalidSkipped: 0,
      },
      onPage() {},
    }),
    /another username/,
  );
});
