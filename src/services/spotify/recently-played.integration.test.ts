import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { syncRecentlyPlayed } from "./recently-played";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

function spotifyPage(playedAt: string) {
  return {
    items: [
      {
        played_at: playedAt,
        track: {
          id: "replacement-id",
          uri: "spotify:track:replacement-id",
          type: "track",
          name: "Track",
          duration_ms: 180_000,
          is_local: false,
          linked_from: { id: "original-id" },
          artists: [{ name: "Artist" }],
        },
      },
    ],
    next: null,
    cursors: null,
  };
}

integrationTest(
  "repeated feed is idempotent and a newer reproduction advances lastPlayedAt for all relinking aliases",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `music-history-${suffix}@example.test` },
    });
    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-${suffix}`,
        access_token: "valid-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        scope: "user-read-email user-read-recently-played",
      },
    });
    await prisma.musicPlaybackPolicy.create({
      data: {
        userId: user.id,
        enabled: true,
        windowValue: 30,
        windowUnit: "DAYS",
      },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    let playedAt = "2026-08-08T12:00:00.000Z";
    let calls = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      assert.match(url, /\/me\/player\/recently-played\?/);
      calls += 1;
      return new Response(JSON.stringify(spotifyPage(playedAt)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const first = await syncRecentlyPlayed(
        user.id,
        new Date("2026-08-08T12:01:00.000Z"),
      );
      assert.equal(first.eventsRead, 1);

      const firstStates = await prisma.trackListeningState.findMany({
        where: { userId: user.id },
        orderBy: { spotifyTrackId: "asc" },
      });
      assert.deepEqual(
        firstStates.map((state) => [state.spotifyTrackId, state.lastPlayedAt.toISOString()]),
        [
          ["original-id", "2026-08-08T12:00:00.000Z"],
          ["replacement-id", "2026-08-08T12:00:00.000Z"],
        ],
      );

      // Exact same provider event must not create additional history rows.
      await syncRecentlyPlayed(user.id, new Date("2026-08-08T12:02:00.000Z"));
      assert.equal(
        await prisma.trackListeningState.count({ where: { userId: user.id } }),
        2,
      );

      // A later playback restarts cooldown by monotonically advancing both aliases.
      playedAt = "2026-08-08T13:00:00.000Z";
      await syncRecentlyPlayed(user.id, new Date("2026-08-08T13:01:00.000Z"));
      const finalStates = await prisma.trackListeningState.findMany({
        where: { userId: user.id },
        orderBy: { spotifyTrackId: "asc" },
      });
      assert.deepEqual(
        finalStates.map((state) => [state.spotifyTrackId, state.lastPlayedAt.toISOString()]),
        [
          ["original-id", "2026-08-08T13:00:00.000Z"],
          ["replacement-id", "2026-08-08T13:00:00.000Z"],
        ],
      );
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
