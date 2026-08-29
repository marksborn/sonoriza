import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  buildListeningHistoryWhere,
  historyFilterQueryString,
  LISTENING_HISTORY_EPOCH,
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

test("HISTORY-04 query builder preserves active filters and excludes Unix epoch", () => {
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

  const where = buildListeningHistoryWhere("user-a", filters);
  assert.equal(where.userId, "user-a");
  assert.equal(where.source, "LASTFM_SCROBBLE");
  assert.ok(where.playedAt && typeof where.playedAt === "object");
  assert.equal(
    (where.playedAt as { gt?: Date }).gt?.getTime(),
    LISTENING_HISTORY_EPOCH.getTime(),
  );
  assert.ok(where.OR);
});

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest("HISTORY-04 explorer keeps rows isolated by user and filters locally", async (t) => {
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

  await prisma.trackListeningEvent.createMany({
    data: [
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
        playedAt: new Date("2026-08-28T12:00:00.000Z"),
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
});

integrationTest("HISTORY-04 database rejects a new non-positive playedAt", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: { email: `history-epoch-guard-${suffix}@example.test` },
  });

  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } });
  });

  await assert.rejects(
    prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        trackName: "Invalid epoch event",
        artistName: "Invalid",
        playedAt: new Date(0),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `epoch-${suffix}`,
      },
    }),
    /after Unix epoch/,
  );
});
