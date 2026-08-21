import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { COMPLETE_PROFILE_EVENT_BATCH_SIZE } from "./complete-profile-batched";
import { getProjectedBatchedCompleteMusicDiscoveryProfile } from "./complete-profile-projected";
import { buildMusicDiscoveryProfile } from "./profile";

const DAY_MS = 24 * 60 * 60 * 1_000;
const AS_OF = new Date("2026-08-21T14:00:00.000Z");

test("projected COMPLETE loader preserves profile semantics without materializing metadata JSON", async () => {
  const events = Array.from(
    { length: COMPLETE_PROFILE_EVENT_BATCH_SIZE + 1 },
    (_, index) => {
      const trackIndex = index % 211;
      const isExtended = index % 3 === 0;
      const playedAt = new Date(
        AS_OF.getTime() - (10 + (index % 500)) * DAY_MS,
      );

      return {
        id: `event-${String(index).padStart(6, "0")}`,
        source: isExtended
          ? ("SPOTIFY_EXTENDED_HISTORY" as const)
          : index % 3 === 1
            ? ("LASTFM_SCROBBLE" as const)
            : ("SPOTIFY_RECENTLY_PLAYED" as const),
        spotifyTrackId: `track-${String(trackIndex).padStart(3, "0")}`,
        spotifyUri: `spotify:track:track-${String(trackIndex).padStart(3, "0")}`,
        trackName: `Track ${trackIndex}`,
        artistName:
          trackIndex % 31 === 0
            ? "Detonautas"
            : trackIndex % 47 === 0
              ? "Spotify"
              : `Artist ${trackIndex % 53}`,
        albumName: `Album ${trackIndex % 29}`,
        playedAt,
        metadata: isExtended
          ? {
              spotifyExtendedHistory: {
                ...(index % 5 === 0 ? {} : { msPlayed: 60_000 + index }),
                ...(index % 17 === 0 ? { skipped: true } : {}),
                ...(index % 19 === 0 ? { explicitSkip: true } : {}),
              },
              ignoredPayload: {
                largeField: "this must never be materialized by the projected loader",
              },
            }
          : {
              ignoredPayload: {
                largeField: "non-extended metadata is irrelevant to DISCOVERY profile",
              },
            },
      };
    },
  );

  const inferredSkips = [
    {
      spotifyTrackId: "track-005",
      inferredAt: new Date(AS_OF.getTime() - DAY_MS),
      consumedAt: null,
    },
  ];
  const trackStates = [
    {
      spotifyTrackId: "track-005",
      lastPlayedAt: new Date(AS_OF.getTime() - 20 * DAY_MS),
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

  let rawCalls = 0;
  let legacyFindManyCalls = 0;

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
      findMany: async () => {
        legacyFindManyCalls += 1;
        throw new Error("projected path must not call TrackListeningEvent.findMany");
      },
    },
    $queryRawUnsafe: async (
      query: string,
      userId: string,
      cursorId: string | null,
      take: number,
    ) => {
      rawCalls += 1;
      assert.equal(userId, "user-1");
      assert.equal(take, COMPLETE_PROFILE_EVENT_BATCH_SIZE);
      assert.match(query, /AS "extendedEvidencePresent"/);
      assert.match(query, /AS "msPlayed"/);
      assert.match(query, /AS "explicitSkip"/);
      assert.match(query, /"metadata"->'spotifyExtendedHistory'/);

      const start = cursorId
        ? events.findIndex((event) => event.id === cursorId) + 1
        : 0;

      return events.slice(start, start + take).map((event) => {
        const metadata = asRecord(event.metadata);
        const extended = asRecord(metadata?.spotifyExtendedHistory);
        const msPlayed =
          typeof extended?.msPlayed === "number" &&
          Number.isFinite(extended.msPlayed)
            ? extended.msPlayed
            : null;
        const explicitSkip =
          extended?.explicitSkip === true || extended?.skipped === true;

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
          msPlayed,
          explicitSkip,
        };
      });
    },
  } as unknown as PrismaClient;

  const projected = await getProjectedBatchedCompleteMusicDiscoveryProfile(
    "user-1",
    {
      asOf: AS_OF,
      client: fakeClient,
    },
  );

  assert.equal(rawCalls, 2);
  assert.equal(legacyFindManyCalls, 0);
  assert.deepEqual(projected, legacy);
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
