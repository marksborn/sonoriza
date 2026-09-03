import assert from "node:assert/strict";
import test from "node:test";

import type { LastFmRecentTracksPage } from "@/services/lastfm/client";

import { readLastFmRecentObservation } from "./lastfm-coverage-reader";

const from = new Date("2026-09-03T12:00:00.000Z");
const to = new Date("2026-09-03T14:00:00.000Z");

function page(input: {
  page: number;
  totalPages: number;
  total: number;
  events?: LastFmRecentTracksPage["events"];
  nowPlayingCount?: number;
}): LastFmRecentTracksPage {
  return {
    username: "marks",
    page: input.page,
    perPage: 200,
    totalPages: input.totalPages,
    total: input.total,
    events: input.events ?? [],
    nowPlayingCount: input.nowPlayingCount ?? 0,
    invalidCount: 0,
  };
}

function event(key: string, playedAt: string) {
  return {
    source: "LASTFM_SCROBBLE" as const,
    sourceEventKey: key,
    playedAt: new Date(playedAt),
    trackName: `Track ${key}`,
    artistName: "Artist",
    albumName: null,
    trackMbid: null,
    artistMbid: null,
    albumMbid: null,
    lastFmUrl: null,
    loved: null,
  };
}

test("Gate 2 reader fetches every reported Last.fm page and returns ascending deduplicated scrobbles", async () => {
  const calls: number[] = [];
  const pages = new Map<number, LastFmRecentTracksPage>([
    [
      1,
      page({
        page: 1,
        totalPages: 2,
        total: 3,
        nowPlayingCount: 1,
        events: [
          event("b", "2026-09-03T12:20:00.000Z"),
          event("a", "2026-09-03T12:10:00.000Z"),
        ],
      }),
    ],
    [
      2,
      page({
        page: 2,
        totalPages: 2,
        total: 3,
        events: [
          event("c", "2026-09-03T12:30:00.000Z"),
          event("a", "2026-09-03T12:10:00.000Z"),
        ],
      }),
    ],
  ]);

  const result = await readLastFmRecentObservation({
    client: {
      async getRecentTracksPage(input) {
        calls.push(input.page ?? 1);
        return pages.get(input.page ?? 1)!;
      },
    },
    username: "marks",
    from,
    to,
    observedAt: to,
    maxPages: 5,
  });

  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.complete, true);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.totalPages, 2);
  assert.equal(result.nowPlayingCount, 1);
  assert.deepEqual(
    result.scrobbles.map((row) => row.sourceEventKey),
    ["a", "b", "c"],
  );
});

test("Gate 2 reader reports incomplete pagination instead of laundering a truncated page set into confirmed coverage", async () => {
  const calls: number[] = [];
  const result = await readLastFmRecentObservation({
    client: {
      async getRecentTracksPage(input) {
        const current = input.page ?? 1;
        calls.push(current);
        return page({
          page: current,
          totalPages: 4,
          total: 800,
          events: [event(`p${current}`, `2026-09-03T12:0${current}:00.000Z`)],
        });
      },
    },
    username: "marks",
    from,
    to,
    maxPages: 2,
  });

  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.totalPages, 4);
  assert.equal(result.complete, false);
});

test("Gate 2 reader treats one empty Last.fm response with totalPages=0 as complete", async () => {
  const result = await readLastFmRecentObservation({
    client: {
      async getRecentTracksPage() {
        return page({ page: 1, totalPages: 0, total: 0 });
      },
    },
    username: "marks",
    from,
    to,
  });

  assert.equal(result.complete, true);
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.totalPages, 0);
  assert.equal(result.scrobbles.length, 0);
});
