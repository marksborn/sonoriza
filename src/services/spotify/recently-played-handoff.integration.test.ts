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
        context: { type: "playlist", uri: "spotify:playlist:handoff" },
        track: {
          id: "track-id",
          uri: "spotify:track:track-id",
          type: "track",
          name: "Track",
          duration_ms: 180_000,
          is_local: false,
          artists: [{ id: "artist-id", name: "Artist" }],
          album: { id: "album-id", name: "Album" },
        },
      },
    ],
    next: null,
    cursors: null,
  };
}

async function createHistoryUser(suffix: string) {
  const user = await prisma.user.create({
    data: { email: `history-handoff-${suffix}@example.test` },
  });
  await prisma.account.create({
    data: {
      userId: user.id,
      type: "oauth",
      provider: "spotify",
      providerAccountId: `spotify-handoff-${suffix}`,
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
  return user;
}

integrationTest(
  "Spotify updates cooldown before an established Last.fm handoff but only persists play events after it",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await createHistoryUser(suffix);
    const handoff = new Date("2026-08-12T12:30:00.000Z");
    await prisma.lastFmBackfillRun.create({
      data: {
        userId: user.id,
        username: "marks",
        status: "PARTIAL",
        to: handoff,
        acceptedEvents: 1,
        insertedEvents: 1,
        nextPage: 2,
      },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    let playedAt = "2026-08-12T12:00:00.000Z";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(spotifyPage(playedAt)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const before = await syncRecentlyPlayed(
        user.id,
        new Date("2026-08-12T12:05:00.000Z"),
      );
      assert.equal(before.listeningEventsInserted, 0);
      assert.equal(before.listeningEventsSuppressedByHandoff, 1);
      assert.equal(
        await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
        0,
      );
      const cooldownBefore = await prisma.trackListeningState.findUnique({
        where: {
          userId_spotifyTrackId: { userId: user.id, spotifyTrackId: "track-id" },
        },
      });
      assert.equal(
        cooldownBefore?.lastPlayedAt.toISOString(),
        "2026-08-12T12:00:00.000Z",
      );

      playedAt = "2026-08-12T13:00:00.000Z";
      const after = await syncRecentlyPlayed(
        user.id,
        new Date("2026-08-12T13:05:00.000Z"),
      );
      assert.equal(after.listeningEventsInserted, 1);
      assert.equal(after.listeningEventsSuppressedByHandoff, 0);
      assert.equal(
        await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
        1,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

integrationTest(
  "a failed Last.fm run without persisted coverage cannot suppress Spotify history",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await createHistoryUser(suffix);
    await prisma.lastFmBackfillRun.create({
      data: {
        userId: user.id,
        username: "marks",
        status: "FAILED",
        to: new Date("2026-08-12T12:30:00.000Z"),
        acceptedEvents: 0,
        insertedEvents: 0,
        error: "provider unavailable before first page",
        finishedAt: new Date("2026-08-12T12:31:00.000Z"),
      },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(spotifyPage("2026-08-12T12:00:00.000Z")), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    try {
      const result = await syncRecentlyPlayed(
        user.id,
        new Date("2026-08-12T12:05:00.000Z"),
      );
      assert.equal(result.listeningEventsInserted, 1);
      assert.equal(result.listeningEventsSuppressedByHandoff, 0);
      assert.equal(
        await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
        1,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
