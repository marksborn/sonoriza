import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { importLastFmHistory } from "./import-history";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest("Last.fm uses the first Spotify event as an exclusive upper boundary", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({ data: { email: `lastfm-${suffix}@example.test` } });
  const handoff = new Date("2026-08-12T20:00:00.000Z");
  await prisma.trackListeningEvent.create({
    data: {
      userId: user.id,
      spotifyTrackId: "spotify-track",
      trackName: "Spotify Track",
      artistName: "Spotify Artist",
      playedAt: handoff,
      source: "SPOTIFY_RECENTLY_PLAYED",
      sourceEventKey: `spotify-${suffix}`,
    },
  });
  t.after(() => prisma.user.delete({ where: { id: user.id } }).then(() => undefined));

  const originalFetch = globalThis.fetch;
  const requestedTo: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    const method = url.searchParams.get("method");
    if (method === "user.getinfo") {
      return new Response(JSON.stringify({ user: { name: "marks", playcount: "1", registered: { unixtime: "1325376000" } } }), { status: 200 });
    }
    if (method === "user.getrecenttracks") {
      requestedTo.push(url.searchParams.get("to") ?? "");
      return new Response(JSON.stringify({ recenttracks: { track: [{ name: "Old", artist: { name: "Artist" }, date: { uts: "1700000000" } }], "@attr": { user: "marks", page: "1", perPage: "200", totalPages: "1", total: "1" } } }), { status: 200 });
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;

  try {
    const result = await importLastFmHistory({ userId: user.id, username: "marks", apiKey: "test-key" });
    assert.equal(result.lastFmHistoryUntilExclusive.toISOString(), handoff.toISOString());
    assert.equal(result.lastFmHistoryUntil.toISOString(), "2026-08-12T19:59:59.000Z");
    assert.deepEqual(requestedTo, [String(Math.floor(handoff.getTime() / 1000))]);
    assert.equal(result.insertedEvents, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
