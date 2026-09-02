import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { createCompliantDiscoveryProfileClient } from "./discovery-profile-policy-client";

const PROJECTED_QUERY = `
  /* PERF-01: project only the Extended History facts consumed by DISCOVERY */
  SELECT * FROM "TrackListeningEvent"
`;

type GuardedClientShape = {
  musicPreferenceSignal: { findMany(): Promise<unknown[]> };
  trackListeningState: { findMany(): Promise<unknown[]> };
  lastFmBackfillRun: { findFirst(): Promise<unknown> };
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

test("restricted auxiliary behavioral inputs are quarantined without touching their delegates", async () => {
  let signalReads = 0;
  let stateReads = 0;
  let lastFmCoverageReads = 0;

  const base = {
    user: {},
    musicPreferenceSignal: {
      findMany: async () => {
        signalReads += 1;
        return [{ spotifyTrackId: "forbidden-signal" }];
      },
    },
    trackListeningState: {
      findMany: async () => {
        stateReads += 1;
        return [{ spotifyTrackId: "forbidden-state" }];
      },
    },
    musicPlaybackPolicy: {},
    lastFmBackfillRun: {
      findFirst: async () => {
        lastFmCoverageReads += 1;
        return { from: new Date() };
      },
    },
    $queryRawUnsafe: async () => [],
  } as unknown as PrismaClient;

  const guarded = createCompliantDiscoveryProfileClient(base) as unknown as GuardedClientShape;

  assert.deepEqual(await guarded.musicPreferenceSignal.findMany(), []);
  assert.deepEqual(await guarded.trackListeningState.findMany(), []);
  assert.equal(await guarded.lastFmBackfillRun.findFirst(), null);
  assert.equal(signalReads, 0);
  assert.equal(stateReads, 0);
  assert.equal(lastFmCoverageReads, 0);
});

test("projected history scans past a fully blocked page instead of truncating pagination", async () => {
  const calls: Array<{ cursor: unknown; take: unknown }> = [];

  const base = {
    user: {},
    musicPreferenceSignal: {},
    trackListeningState: {},
    musicPlaybackPolicy: {},
    lastFmBackfillRun: {},
    $queryRawUnsafe: async (
      _query: string,
      _userId: unknown,
      cursor: unknown,
      take: unknown,
    ) => {
      calls.push({ cursor, take });
      if (cursor === null) {
        return [
          {
            id: "001",
            source: "SPOTIFY_RECENTLY_PLAYED",
            extendedEvidencePresent: false,
          },
          {
            id: "002",
            source: "LASTFM_SCROBBLE",
            extendedEvidencePresent: false,
          },
        ];
      }
      if (cursor === "002") {
        return [
          {
            id: "003",
            source: "IMPORT",
            extendedEvidencePresent: false,
          },
        ];
      }
      throw new Error(`unexpected cursor ${String(cursor)}`);
    },
  } as unknown as PrismaClient;

  const guarded = createCompliantDiscoveryProfileClient(base) as unknown as GuardedClientShape;
  const rows = await guarded.$queryRawUnsafe<unknown[]>(
    PROJECTED_QUERY,
    "user-1",
    null,
    2,
  );

  assert.deepEqual(rows, []);
  assert.deepEqual(calls, [
    { cursor: null, take: 2 },
    { cursor: "002", take: 2 },
  ]);
});

test("mixed Last.fm plus Spotify projected evidence is blocked before aggregation", async () => {
  let calls = 0;
  const base = {
    user: {},
    musicPreferenceSignal: {},
    trackListeningState: {},
    musicPlaybackPolicy: {},
    lastFmBackfillRun: {},
    $queryRawUnsafe: async () => {
      calls += 1;
      return [
        {
          id: "mixed-1",
          source: "LASTFM_SCROBBLE",
          extendedEvidencePresent: true,
        },
      ];
    },
  } as unknown as PrismaClient;

  const guarded = createCompliantDiscoveryProfileClient(base) as unknown as GuardedClientShape;
  const rows = await guarded.$queryRawUnsafe<unknown[]>(
    PROJECTED_QUERY,
    "user-1",
    null,
    2,
  );

  assert.deepEqual(rows, []);
  assert.equal(calls, 1);
});

test("unrelated raw queries are forwarded unchanged", async () => {
  const expected = [{ ok: true }];
  let calls = 0;
  const base = {
    user: {},
    musicPreferenceSignal: {},
    trackListeningState: {},
    musicPlaybackPolicy: {},
    lastFmBackfillRun: {},
    $queryRawUnsafe: async () => {
      calls += 1;
      return expected;
    },
  } as unknown as PrismaClient;

  const guarded = createCompliantDiscoveryProfileClient(base) as unknown as GuardedClientShape;
  const rows = await guarded.$queryRawUnsafe("SELECT 1");

  assert.strictEqual(rows, expected);
  assert.equal(calls, 1);
});
