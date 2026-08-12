import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  loadMusicRepeatContext,
  MusicRepeatScopeRequiredError,
  syncRecentlyPlayed,
} from "./recently-played";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

function spotifyPage(playedAt: string) {
  return {
    items: [
      {
        played_at: playedAt,
        context: { type: "playlist", uri: "spotify:playlist:history-test" },
        track: {
          id: "replacement-id",
          uri: "spotify:track:replacement-id",
          type: "track",
          name: "Track",
          duration_ms: 180_000,
          is_local: false,
          linked_from: { id: "original-id" },
          artists: [{ id: "artist-id", name: "Artist" }],
          album: { id: "album-id", name: "Album" },
          external_ids: { isrc: "BRABC1234567" },
        },
      },
    ],
    next: null,
    cursors: null,
  };
}

integrationTest(
  "repeated feed is idempotent and a newer reproduction advances state while adding one immutable event",
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
      assert.equal(first.listeningEventsInserted, 1);
      assert.equal(first.listeningEventsDuplicateCount, 0);

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

      const firstEvents = await prisma.trackListeningEvent.findMany({
        where: { userId: user.id },
      });
      assert.equal(firstEvents.length, 1);
      assert.equal(firstEvents[0]?.spotifyTrackId, "original-id");
      assert.equal(firstEvents[0]?.trackName, "Track");
      assert.equal(firstEvents[0]?.artistName, "Artist");
      assert.equal(firstEvents[0]?.albumName, "Album");
      assert.equal(firstEvents[0]?.isrc, "BRABC1234567");
      assert.equal(firstEvents[0]?.contextUri, "spotify:playlist:history-test");
      assert.equal(firstEvents[0]?.source, "SPOTIFY_RECENTLY_PLAYED");

      // Exact same provider event must not create additional state/history rows.
      const repeated = await syncRecentlyPlayed(
        user.id,
        new Date("2026-08-08T12:02:00.000Z"),
      );
      assert.equal(repeated.listeningEventsInserted, 0);
      assert.equal(repeated.listeningEventsDuplicateCount, 1);
      assert.equal(
        await prisma.trackListeningState.count({ where: { userId: user.id } }),
        2,
      );
      assert.equal(
        await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
        1,
      );

      // A later playback restarts cooldown and is a second historical event.
      playedAt = "2026-08-08T13:00:00.000Z";
      const later = await syncRecentlyPlayed(
        user.id,
        new Date("2026-08-08T13:01:00.000Z"),
      );
      assert.equal(later.listeningEventsInserted, 1);
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
      assert.equal(
        await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
        2,
      );
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

integrationTest(
  "30-day boundary blocks the cutoff instant, 31-day history and never-observed tracks stay eligible",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `music-boundary-${suffix}@example.test` },
    });
    await prisma.musicPlaybackPolicy.create({
      data: {
        userId: user.id,
        enabled: true,
        windowValue: 30,
        windowUnit: "DAYS",
      },
    });
    await prisma.trackListeningState.createMany({
      data: [
        {
          userId: user.id,
          spotifyTrackId: "exact-cutoff",
          spotifyUri: "spotify:track:exact-cutoff",
          lastPlayedAt: new Date("2026-07-09T12:00:00.000Z"),
        },
        {
          userId: user.id,
          spotifyTrackId: "older-than-cutoff",
          spotifyUri: "spotify:track:older-than-cutoff",
          lastPlayedAt: new Date("2026-07-08T11:59:59.999Z"),
        },
      ],
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const context = await loadMusicRepeatContext(
      user.id,
      new Date("2026-08-08T12:00:00.000Z"),
    );

    assert.equal(context.cutoff?.toISOString(), "2026-07-09T12:00:00.000Z");
    assert.equal(context.blockedTrackIds.has("exact-cutoff"), true);
    assert.equal(context.blockedTrackIds.has("older-than-cutoff"), false);
    assert.equal(context.blockedTrackIds.has("never-observed"), false);
  },
);

integrationTest(
  "enabled MUSIC-01 fails explicitly when an existing Spotify grant lacks recently-played scope",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `music-scope-${suffix}@example.test` },
    });
    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-scope-${suffix}`,
        access_token: "valid-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        scope: "user-read-email user-library-read",
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

    await assert.rejects(
      () => syncRecentlyPlayed(user.id),
      (error: unknown) => {
        assert.ok(error instanceof MusicRepeatScopeRequiredError);
        assert.match(error.message, /reconnect spotify/i);
        return true;
      },
    );
  },
);
