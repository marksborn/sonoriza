import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  buildListeningHistoryWhere,
  historyFilterQueryString,
  listListeningHistory,
  resolveListeningHistoryFilters,
} from "./explorer";

test("HISTORY-04 defaults to the last seven calendar days", () => {
  const now = new Date(2026, 7, 29, 14, 30, 0);
  const filters = resolveListeningHistoryFilters({}, now);

  assert.equal(filters.period, "7d");
  assert.equal(filters.page, 1);
  assert.equal(filters.from?.getFullYear(), 2026);
  assert.equal(filters.from?.getMonth(), 7);
  assert.equal(filters.from?.getDate(), 23);
  assert.equal(filters.toExclusive?.getDate(), 30);
});

test("HISTORY-04 custom range is inclusive by calendar day and sanitized", () => {
  const filters = resolveListeningHistoryFilters({
    period: "custom",
    from: "2026-08-20",
    to: "2026-08-22",
    q: "  Korn  ",
    page: "9999",
  });

  assert.equal(filters.query, "Korn");
  assert.equal(filters.page, 500);
  assert.equal(filters.from?.getDate(), 20);
  assert.equal(filters.toExclusive?.getDate(), 23);
});

test("HISTORY-04 query builder combines filters with the authoritative Last.fm window", () => {
  const filters = resolveListeningHistoryFilters({
    period: "30d",
    q: "Deftones",
    source: "LASTFM_SCROBBLE",
    page: "3",
  });
  const queryString = historyFilterQueryString(filters, { page: 1 });

  assert.equal(
    queryString,
    "period=30d&q=Deftones&source=LASTFM_SCROBBLE",
  );

  const lastFmWindow = {
    from: new Date("2013-11-12T12:17:22.000Z"),
    to: new Date("2027-01-01T00:00:00.000Z"),
  };
  const where = buildListeningHistoryWhere("user-a", filters, lastFmWindow);
  const clauses = where.AND as Prisma.TrackListeningEventWhereInput[];

  assert.equal(clauses[0]?.userId, "user-a");
  const canonicalOr = clauses[1]?.OR as Prisma.TrackListeningEventWhereInput[];
  assert.equal(canonicalOr[1]?.source, "LASTFM_SCROBBLE");
  const canonicalPlayedAt = canonicalOr[1]?.playedAt as Prisma.DateTimeFilter;
  assert.equal(
    (canonicalPlayedAt.gte as Date | undefined)?.toISOString(),
    "2013-11-12T12:17:22.000Z",
  );
  assert.equal(
    (canonicalPlayedAt.lt as Date | undefined)?.toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
  assert.equal(clauses[2]?.source, "LASTFM_SCROBBLE");
  assert.ok(clauses[2]?.playedAt);
  assert.ok(clauses[2]?.OR);
});

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest("HISTORY-04 explorer keeps rows isolated and excludes Last.fm residue outside its window", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: { email: `history-explorer-${suffix}@example.test` },
  });
  const otherUser = await prisma.user.create({
    data: { email: `history-explorer-other-${suffix}@example.test` },
  });

  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } });
  });

  await prisma.lastFmBackfillRun.createMany({
    data: [
      {
        userId: user.id,
        username: `history-${suffix}`,
        status: "SUCCESS",
        from: new Date("2013-11-12T12:17:22.000Z"),
        to: new Date("2027-01-01T00:00:00.000Z"),
        finishedAt: new Date("2026-08-29T12:00:00.000Z"),
      },
      {
        userId: otherUser.id,
        username: `history-other-${suffix}`,
        status: "SUCCESS",
        from: new Date("2013-01-01T00:00:00.000Z"),
        to: new Date("2027-01-01T00:00:00.000Z"),
        finishedAt: new Date("2026-08-29T12:00:00.000Z"),
      },
    ],
  });

  await prisma.trackListeningEvent.createMany({
    data: [
      {
        userId: user.id,
        trackName: "Synthetic Last.fm residue",
        artistName: "Invalid",
        playedAt: new Date("1970-01-01T00:00:01.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `synthetic-${suffix}`,
      },
      {
        userId: user.id,
        trackName: "Here to Stay",
        artistName: "Korn",
        albumName: "Untouchables",
        playedAt: new Date("2026-08-29T12:00:00.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `a-${suffix}`,
      },
      {
        userId: user.id,
        trackName: "Digital Bath",
        artistName: "Deftones",
        albumName: "White Pony",
        playedAt: new Date("2008-08-28T12:00:00.000Z"),
        source: "SPOTIFY_EXTENDED_HISTORY",
        sourceEventKey: `b-${suffix}`,
      },
      {
        userId: otherUser.id,
        trackName: "Hidden other user row",
        artistName: "Other",
        playedAt: new Date("2026-08-29T12:30:00.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `c-${suffix}`,
      },
    ],
  });

  const filters = resolveListeningHistoryFilters(
    { period: "all", q: "Korn" },
    new Date(2026, 7, 29, 14, 0, 0),
  );
  const result = await listListeningHistory(user.id, filters);

  assert.equal(result.totalCount, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.trackName, "Here to Stay");
  assert.equal(result.items[0]?.source, "LASTFM_SCROBBLE");

  const all = await listListeningHistory(
    user.id,
    resolveListeningHistoryFilters({ period: "all" }),
  );
  assert.equal(all.totalCount, 2);
  assert.equal(
    all.items.some((item) => item.trackName === "Synthetic Last.fm residue"),
    false,
  );
  assert.equal(
    all.items.some((item) => item.trackName === "Digital Bath"),
    true,
  );
});
