import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { COMPLETE_PROFILE_EVENT_BATCH_SIZE } from "./complete-profile-batched";
import { getProjectedBatchedRetainedCompleteMusicDiscoveryProfile } from "./complete-profile-projected";
import { buildMusicDiscoveryProfile } from "./profile";

const AS_OF = new Date("2026-08-21T16:00:00.000Z");

test("projected lean COMPLETE finalizer preserves runtime scoring facts while dropping unused track payload", async () => {
  const events = [
    {
      id: "event-001",
      source: "SPOTIFY_EXTENDED_HISTORY" as const,
      spotifyTrackId: "track-a",
      spotifyUri: "spotify:track:track-a",
      trackName: "Track A",
      artistName: "Artist A",
      albumName: "Album A",
      playedAt: new Date("2026-08-10T10:00:00.000Z"),
      metadata: {
        spotifyExtendedHistory: {
          msPlayed: 180_000,
          explicitSkip: false,
        },
      },
    },
    {
      id: "event-002",
      source: "SPOTIFY_RECENTLY_PLAYED" as const,
      spotifyTrackId: "track-a",
      spotifyUri: "spotify:track:track-a",
      trackName: "Track A",
      artistName: "Artist A",
      albumName: "Album A",
      playedAt: new Date("2026-08-11T10:00:00.000Z"),
      metadata: null,
    },
    {
      id: "event-003",
      source: "LASTFM_SCROBBLE" as const,
      spotifyTrackId: "track-b",
      spotifyUri: "spotify:track:track-b",
      trackName: "Track B",
      artistName: "Artist B",
      albumName: "Album B",
      playedAt: new Date("2025-01-10T10:00:00.000Z"),
      metadata: null,
    },
  ];
  const inferredSkips = [
    {
      spotifyTrackId: "track-a",
      inferredAt: new Date("2026-08-12T10:00:00.000Z"),
      consumedAt: null,
    },
  ];
  const trackStates = [
    {
      spotifyTrackId: "track-a",
      lastPlayedAt: new Date("2026-08-11T10:00:00.000Z"),
    },
  ];
  const playbackPolicy = {
    enabled: true,
    windowValue: 30,
    windowUnit: "DAYS" as const,
  };

  const canonical = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips,
    trackStates,
    playbackPolicy,
    lastFmValidFrom: null,
    completeUniverse: true,
  });

  let rawCalls = 0;
  let rawQuery = "";
  let projectedRows: Array<{
    spotifyUri: string | null;
    albumName: string | null;
    metadata?: unknown;
  }> = [];
  const fakeClient = {
    user: {
      findUnique: async () => ({ id: "user-lean" }),
    },
    musicPreferenceSignal: {
      findMany: async () => inferredSkips,
    },
    trackListeningState: {
      findMany: async () => trackStates,
    },
    musicPlaybackPolicy: {
      findUnique: async () => playbackPolicy,
    },
    lastFmBackfillRun: {
      findFirst: async () => null,
    },
    trackListeningEvent: {
      findMany: async () => {
        throw new Error("projected lean path must not call TrackListeningEvent.findMany");
      },
    },
    $queryRawUnsafe: async (
      query: string,
      userId: string,
      cursorId: string | null,
      take: number,
    ) => {
      rawCalls += 1;
      rawQuery = query;
      assert.equal(userId, "user-lean");
      assert.equal(take, COMPLETE_PROFILE_EVENT_BATCH_SIZE);
      assert.equal(cursorId, null);
      const rows = events.map((event) => {
        const metadata = asRecord(event.metadata);
        const extended = asRecord(metadata?.spotifyExtendedHistory);
        return {
          id: event.id,
          source: event.source,
          spotifyTrackId: event.spotifyTrackId,
          spotifyUri: event.spotifyUri,
          trackName: event.trackName,
          artistName: event.artistName,
          albumName: event.albumName,
          playedAt: event.playedAt,
          extendedEvidencePresent: extended !== null,
          msPlayed:
            typeof extended?.msPlayed === "number" ? extended.msPlayed : null,
          explicitSkip:
            extended?.explicitSkip === true || extended?.skipped === true,
        };
      });
      projectedRows = rows;
      return rows;
    },
  } as unknown as PrismaClient;

  const retained =
    await getProjectedBatchedRetainedCompleteMusicDiscoveryProfile(
      "user-lean",
      {
        asOf: AS_OF,
        client: fakeClient,
      },
    );

  assert.equal(rawCalls, 1);
  assert.match(rawQuery, /NULL::text AS "spotifyUri"/);
  assert.match(rawQuery, /NULL::text AS "albumName"/);
  assert.equal(projectedRows.length, events.length);
  assert.equal(projectedRows[0]?.spotifyUri, null);
  assert.equal(projectedRows[0]?.albumName, null);
  assert.deepEqual(projectedRows[0]?.metadata, {
    spotifyExtendedHistory: { msPlayed: 0 },
  });
  assert.equal(projectedRows[1]?.metadata, null);
  assert.deepEqual(retained, {
    generatedAt: canonical.generatedAt,
    heuristics: canonical.heuristics,
    coverage: canonical.coverage,
    cooldown: canonical.cooldown,
    topArtistsHistorical: canonical.topArtistsHistorical,
    topTracksHistorical: canonical.topTracksHistorical.map((track) => ({
      ...track,
      spotifyUri: null,
      albumName: null,
    })),
  });
  assert.deepEqual(Object.keys(retained).sort(), [
    "cooldown",
    "coverage",
    "generatedAt",
    "heuristics",
    "topArtistsHistorical",
    "topTracksHistorical",
  ]);
  assert.equal("topArtists30d" in retained, false);
  assert.equal("topArtists90d" in retained, false);
  assert.equal("topArtists365d" in retained, false);
  assert.equal("recentMomentum" in retained, false);
  assert.equal("dormantFavorites" in retained, false);
  assert.equal("rediscoveryReturns" in retained, false);
  assert.equal("familiarCandidates" in retained, false);
  assert.equal("rediscoveryCandidates" in retained, false);
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
