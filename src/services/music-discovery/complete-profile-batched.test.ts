import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  COMPLETE_PROFILE_EVENT_BATCH_SIZE,
  getBatchedCompleteMusicDiscoveryProfile,
  getBatchedRetainedCompleteMusicDiscoveryProfile,
} from "./complete-profile-batched";
import { buildMusicDiscoveryProfile } from "./profile";

const DAY_MS = 24 * 60 * 60 * 1_000;
const AS_OF = new Date("2026-08-21T12:00:00.000Z");

test("batched COMPLETE loader preserves the canonical profile across multiple pages", async () => {
  const events = Array.from(
    { length: COMPLETE_PROFILE_EVENT_BATCH_SIZE + 17 },
    (_, index) => {
      const trackIndex = index % 173;
      const recent = index % 11 === 0;
      const artistName =
        trackIndex % 29 === 0
          ? "Detonautas"
          : trackIndex % 37 === 0
            ? "Spotify"
            : `Artist ${trackIndex % 41}`;
      const playedAt = new Date(
        AS_OF.getTime() - (recent ? index % 20 : 200 + (index % 500)) * DAY_MS,
      );

      return {
        id: `event-${String(index).padStart(6, "0")}`,
        source:
          index % 3 === 0
            ? ("SPOTIFY_EXTENDED_HISTORY" as const)
            : index % 3 === 1
              ? ("LASTFM_SCROBBLE" as const)
              : ("SPOTIFY_RECENTLY_PLAYED" as const),
        spotifyTrackId: `track-${String(trackIndex).padStart(3, "0")}`,
        spotifyUri: `spotify:track:track-${String(trackIndex).padStart(3, "0")}`,
        trackName: `Track ${trackIndex}`,
        artistName,
        albumName: `Album ${trackIndex % 23}`,
        playedAt,
        metadata:
          index % 3 === 0
            ? {
                spotifyExtendedHistory: {
                  msPlayed: 90_000 + index,
                  explicitSkip: index % 17 === 0,
                },
              }
            : null,
      };
    },
  );

  // Exercise hygiene counters without changing the page-boundary assertion.
  events[3] = {
    ...events[3]!,
    playedAt: new Date("1970-01-01T00:00:00.000Z"),
  };
  events[7] = {
    ...events[7]!,
    playedAt: new Date(AS_OF.getTime() + DAY_MS),
  };

  const inferredSkips = [
    {
      spotifyTrackId: "track-005",
      inferredAt: new Date(AS_OF.getTime() - DAY_MS),
      consumedAt: null,
    },
    {
      spotifyTrackId: "track-011",
      inferredAt: new Date(AS_OF.getTime() - 2 * DAY_MS),
      consumedAt: new Date(AS_OF.getTime() - DAY_MS),
    },
  ];
  const trackStates = [
    {
      spotifyTrackId: "track-005",
      lastPlayedAt: new Date(AS_OF.getTime() - 3 * DAY_MS),
    },
    {
      spotifyTrackId: "track-011",
      lastPlayedAt: new Date(AS_OF.getTime() - 400 * DAY_MS),
    },
  ];
  const playbackPolicy = {
    enabled: true,
    windowValue: 30,
    windowUnit: "DAYS" as const,
  };

  const legacy = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips,
    trackStates,
    playbackPolicy,
    lastFmValidFrom: null,
    completeUniverse: true,
  });

  let eventPageCalls = 0;
  const fakeClient = {
    user: {
      findUnique: async () => ({ id: "user-1" }),
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
      findMany: async (args: {
        take: number;
        cursor?: { id: string };
        skip?: number;
      }) => {
        eventPageCalls += 1;
        assert.equal(args.take, COMPLETE_PROFILE_EVENT_BATCH_SIZE);
        const start = args.cursor
          ? events.findIndex((event) => event.id === args.cursor!.id) + 1
          : 0;
        return events.slice(start, start + args.take);
      },
    },
  } as unknown as PrismaClient;

  const batched = await getBatchedCompleteMusicDiscoveryProfile("user-1", {
    asOf: AS_OF,
    client: fakeClient,
  });

  assert.equal(eventPageCalls, 2);
  assert.deepEqual(batched, legacy);

  eventPageCalls = 0;
  const retained = await getBatchedRetainedCompleteMusicDiscoveryProfile(
    "user-1",
    {
      asOf: AS_OF,
      client: fakeClient,
    },
  );

  assert.equal(eventPageCalls, 2);
  assert.deepEqual(retained, {
    generatedAt: legacy.generatedAt,
    heuristics: legacy.heuristics,
    coverage: legacy.coverage,
    cooldown: legacy.cooldown,
    topArtistsHistorical: legacy.topArtistsHistorical,
    topTracksHistorical: legacy.topTracksHistorical,
  });
});

test("numeric epoch-day keys preserve canonical UTC day boundaries", async () => {
  const events = [
    {
      id: "event-001",
      source: "SPOTIFY_RECENTLY_PLAYED" as const,
      spotifyTrackId: "track-utc",
      spotifyUri: "spotify:track:track-utc",
      trackName: "UTC Track",
      artistName: "UTC Artist",
      albumName: "UTC Album",
      playedAt: new Date("2026-08-20T00:00:00.000Z"),
      metadata: null,
    },
    {
      id: "event-002",
      source: "SPOTIFY_RECENTLY_PLAYED" as const,
      spotifyTrackId: "track-utc",
      spotifyUri: "spotify:track:track-utc",
      trackName: "UTC Track",
      artistName: "UTC Artist",
      albumName: "UTC Album",
      playedAt: new Date("2026-08-20T23:59:59.999Z"),
      metadata: null,
    },
    {
      id: "event-003",
      source: "SPOTIFY_RECENTLY_PLAYED" as const,
      spotifyTrackId: "track-utc",
      spotifyUri: "spotify:track:track-utc",
      trackName: "UTC Track",
      artistName: "UTC Artist",
      albumName: "UTC Album",
      playedAt: new Date("2026-08-21T00:00:00.000Z"),
      metadata: null,
    },
  ];

  const legacy = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: null,
    completeUniverse: true,
  });

  const fakeClient = {
    user: {
      findUnique: async () => ({ id: "user-utc" }),
    },
    musicPreferenceSignal: {
      findMany: async () => [],
    },
    trackListeningState: {
      findMany: async () => [],
    },
    musicPlaybackPolicy: {
      findUnique: async () => null,
    },
    lastFmBackfillRun: {
      findFirst: async () => null,
    },
    trackListeningEvent: {
      findMany: async () => events,
    },
  } as unknown as PrismaClient;

  const batched = await getBatchedCompleteMusicDiscoveryProfile("user-utc", {
    asOf: AS_OF,
    client: fakeClient,
  });

  assert.deepEqual(batched, legacy);
  assert.equal(batched.topArtistsHistorical[0]?.distinctListeningDays, 2);
  assert.equal(batched.topArtistsHistorical[0]?.listeningDays30d, 2);
  assert.equal(batched.topTracksHistorical[0]?.distinctListeningDays, 2);
});

test("artist distinct-track references preserve Spotify and unresolved identity counts", async () => {
  const events = [
    {
      id: "event-track-001",
      source: "SPOTIFY_RECENTLY_PLAYED" as const,
      spotifyTrackId: "track-a",
      spotifyUri: "spotify:track:track-a",
      trackName: "Track A",
      artistName: "Reference Artist",
      albumName: "Album A",
      playedAt: new Date("2026-08-16T10:00:00.000Z"),
      metadata: null,
    },
    {
      id: "event-track-002",
      source: "SPOTIFY_EXTENDED_HISTORY" as const,
      spotifyTrackId: "track-a",
      spotifyUri: "spotify:track:track-a",
      trackName: "Track A",
      artistName: "Reference Artist",
      albumName: "Album A",
      playedAt: new Date("2026-08-17T10:00:00.000Z"),
      metadata: {
        spotifyExtendedHistory: {
          msPlayed: 180_000,
          explicitSkip: false,
        },
      },
    },
    {
      id: "event-track-003",
      source: "SPOTIFY_RECENTLY_PLAYED" as const,
      spotifyTrackId: "track-b",
      spotifyUri: "spotify:track:track-b",
      trackName: "Track B",
      artistName: "Reference Artist",
      albumName: "Album B",
      playedAt: new Date("2026-08-18T10:00:00.000Z"),
      metadata: null,
    },
    {
      id: "event-track-004",
      source: "LASTFM_SCROBBLE" as const,
      spotifyTrackId: null,
      spotifyUri: null,
      trackName: "Loose Track",
      artistName: "Reference Artist",
      albumName: "Loose Album",
      playedAt: new Date("2026-08-19T10:00:00.000Z"),
      metadata: null,
    },
    {
      id: "event-track-005",
      source: "LASTFM_SCROBBLE" as const,
      spotifyTrackId: null,
      spotifyUri: null,
      trackName: "Loose Track",
      artistName: "Reference Artist",
      albumName: "Loose Album",
      playedAt: new Date("2026-08-20T10:00:00.000Z"),
      metadata: null,
    },
  ];

  const legacy = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: null,
    completeUniverse: true,
  });

  const fakeClient = {
    user: {
      findUnique: async () => ({ id: "user-track-refs" }),
    },
    musicPreferenceSignal: {
      findMany: async () => [],
    },
    trackListeningState: {
      findMany: async () => [],
    },
    musicPlaybackPolicy: {
      findUnique: async () => null,
    },
    lastFmBackfillRun: {
      findFirst: async () => null,
    },
    trackListeningEvent: {
      findMany: async () => events,
    },
  } as unknown as PrismaClient;

  const batched = await getBatchedCompleteMusicDiscoveryProfile(
    "user-track-refs",
    {
      asOf: AS_OF,
      client: fakeClient,
    },
  );

  assert.deepEqual(batched, legacy);
  assert.equal(batched.topArtistsHistorical[0]?.distinctTrackCount, 3);
  assert.equal(batched.topTracksHistorical.length, 2);
});
