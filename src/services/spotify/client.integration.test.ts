import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/services/playlist-planner";

import { SpotifyClient } from "./client";
import { decodeMusicSourceCache, encodeMusicSourceCache } from "./source-cache";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

function createClient(userId: string): SpotifyClient {
  const Constructor = SpotifyClient as unknown as new (
    accessToken: string,
    userId: string,
  ) => SpotifyClient;
  return new Constructor("test-token", userId);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function cachedTrack(uri: string, title: string): Candidate[] {
  const match = /^spotify:track:([^:]+)$/.exec(uri);
  return [
    {
      uri,
      ...(match?.[1] ? { spotifyTrackId: match[1] } : {}),
      type: "MUSIC",
      title,
      subtitle: "Artist",
      durationMs: 180_000,
    },
  ];
}

integrationTest(
  "persisted music cache reuses unchanged snapshot, refreshes changed snapshot and stays user-isolated",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const userA = await prisma.user.create({
      data: { email: `spotify-cache-a-${suffix}@example.test` },
    });
    const userB = await prisma.user.create({
      data: { email: `spotify-cache-b-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
      await prisma.$disconnect();
    });

    const sourceA = await prisma.sourcePlaylist.create({
      data: {
        userId: userA.id,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "playlist-shared",
        name: "Shared A",
      },
    });

    await prisma.sourcePlaylist.create({
      data: {
        userId: userB.id,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: "playlist-shared",
        name: "Shared B",
        spotifySnapshotId: "snapshot-1",
        cachedCandidates: encodeMusicSourceCache(
          cachedTrack("spotify:track:poison", "Other user's track"),
        ),
        cacheUpdatedAt: new Date(),
      },
    });

    const originalFetch = globalThis.fetch;
    let snapshot = "snapshot-1";
    let itemVersion = 1;
    let metadataCalls = 0;
    let itemCalls = 0;

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/playlists/playlist-shared?fields=snapshot_id")) {
        metadataCalls += 1;
        return jsonResponse({ snapshot_id: snapshot });
      }
      if (url.includes("/playlists/playlist-shared/items?")) {
        itemCalls += 1;
        return jsonResponse({
          items: [
            {
              item: {
                uri: `spotify:track:${itemVersion}`,
                name: `Track ${itemVersion}`,
                duration_ms: 180_000,
                is_local: false,
                type: "track",
                artists: [{ name: "Artist" }],
              },
            },
          ],
          next: null,
        });
      }
      throw new Error(`Unexpected Spotify request: ${url}`);
    }) as typeof fetch;

    try {
      // First run: no cache yet, so read one page and persist snapshot + pool.
      const firstClient = createClient(userA.id);
      assert.deepEqual(
        await firstClient.getPlaylistTracks("playlist-shared"),
        cachedTrack("spotify:track:1", "Track 1"),
      );
      assert.equal(metadataCalls, 2);
      assert.equal(itemCalls, 1);

      const afterFirst = await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: sourceA.id },
        select: {
          spotifySnapshotId: true,
          cachedCandidates: true,
          cacheUpdatedAt: true,
        },
      });
      assert.equal(afterFirst.spotifySnapshotId, "snapshot-1");
      assert.deepEqual(
        decodeMusicSourceCache(afterFirst.cachedCandidates),
        cachedTrack("spotify:track:1", "Track 1"),
      );
      assert.ok(afterFirst.cacheUpdatedAt);

      // New client = new run. Snapshot is unchanged, so only metadata is read.
      metadataCalls = 0;
      itemCalls = 0;
      const secondClient = createClient(userA.id);
      assert.deepEqual(
        await secondClient.getPlaylistTracks("playlist-shared"),
        cachedTrack("spotify:track:1", "Track 1"),
      );
      assert.equal(metadataCalls, 1);
      assert.equal(itemCalls, 0);
      assert.equal(secondClient.getRequestMetrics().cacheHits, 1);
      assert.equal(
        secondClient.getRequestMetrics().sourceReads["PLAYLIST:playlist-shared"]
          ?.pagesRead,
        0,
      );

      // The other user's poisoned cache must never bleed into user A.
      assert.notEqual(
        (await secondClient.getPlaylistTracks("playlist-shared"))[0]?.uri,
        "spotify:track:poison",
      );

      // Changed snapshot: read fresh items and replace A's persisted cache.
      snapshot = "snapshot-2";
      itemVersion = 2;
      metadataCalls = 0;
      itemCalls = 0;
      const thirdClient = createClient(userA.id);
      assert.deepEqual(
        await thirdClient.getPlaylistTracks("playlist-shared"),
        cachedTrack("spotify:track:2", "Track 2"),
      );
      assert.equal(metadataCalls, 2);
      assert.equal(itemCalls, 1);
      assert.equal(
        thirdClient.getRequestMetrics().sourceReads["PLAYLIST:playlist-shared"]
          ?.snapshotChanged,
        1,
      );

      const afterThird = await prisma.sourcePlaylist.findUniqueOrThrow({
        where: { id: sourceA.id },
        select: { spotifySnapshotId: true, cachedCandidates: true },
      });
      assert.equal(afterThird.spotifySnapshotId, "snapshot-2");
      assert.deepEqual(
        decodeMusicSourceCache(afterThird.cachedCandidates),
        cachedTrack("spotify:track:2", "Track 2"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
