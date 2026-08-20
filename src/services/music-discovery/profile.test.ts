import assert from "node:assert/strict";
import test from "node:test";

import type { ListeningEventSource } from "@prisma/client";

import {
  buildMusicDiscoveryProfile,
  type DiscoveryHistoryEvent,
} from "./profile";

const AS_OF = new Date("2026-08-20T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function ago(days: number): Date {
  return new Date(AS_OF.getTime() - days * DAY_MS);
}

function event(input: {
  artist: string;
  track: string;
  daysAgo: number;
  spotifyTrackId?: string | null;
  source?: ListeningEventSource;
  metadata?: unknown;
}): DiscoveryHistoryEvent {
  const spotifyTrackId = input.spotifyTrackId === undefined
    ? `${input.artist}-${input.track}`.replace(/\s+/g, "-").toLowerCase()
    : input.spotifyTrackId;
  return {
    source: input.source ?? "LASTFM_SCROBBLE",
    spotifyTrackId,
    spotifyUri: spotifyTrackId ? `spotify:track:${spotifyTrackId}` : null,
    trackName: input.track,
    artistName: input.artist,
    albumName: "Album",
    playedAt: ago(input.daysAgo),
    metadata: input.metadata ?? null,
  };
}

test("Gate 1 excludes invalid legacy Last.fm rows and keeps explicit/inferred skips separate from plays", () => {
  const events: DiscoveryHistoryEvent[] = [
    {
      ...event({ artist: "Legacy", track: "Synthetic", daysAgo: 1 }),
      playedAt: new Date("1970-01-01T00:00:01.000Z"),
      spotifyTrackId: null,
      spotifyUri: null,
    },
    event({
      artist: "Artist A",
      track: "Track A",
      daysAgo: 10,
      source: "SPOTIFY_EXTENDED_HISTORY",
      metadata: {
        spotifyExtendedHistory: {
          msPlayed: 12_345,
          skipped: true,
          explicitSkip: true,
        },
      },
    }),
    event({ artist: "Artist A", track: "Track A", daysAgo: 400 }),
  ];

  const report = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [
      {
        spotifyTrackId: "artist-a-track-a",
        inferredAt: ago(5),
        consumedAt: null,
      },
    ],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: new Date("2013-11-12T12:17:22.000Z"),
  });

  assert.equal(report.coverage.totalCanonicalEvents, 2);
  assert.equal(report.coverage.invalidLegacyLastFmExcluded, 1);
  assert.equal(report.coverage.extendedEvidenceEvents, 1);
  assert.equal(report.coverage.msPlayedEvidenceEvents, 1);
  assert.equal(report.coverage.explicitSkipEvents, 1);
  assert.equal(report.coverage.inferredSkipSignals, 1);
  assert.equal(report.coverage.pendingInferredSkipSignals, 1);

  const artist = report.topArtistsHistorical[0];
  assert.equal(artist?.artistName, "Artist A");
  assert.equal(artist?.playCount, 2);
  assert.equal(artist?.explicitSkipCount, 1);
  assert.equal(artist?.inferredSkipCount, 1);

  const track = report.topTracksHistorical[0];
  assert.equal(track?.playCount, 2);
  assert.equal(track?.explicitSkipCount, 1);
  assert.equal(track?.inferredSkipCount, 1);
});

test("momentum ranking uses absolute growth so a tiny percentage base does not dominate", () => {
  const events: DiscoveryHistoryEvent[] = [];
  for (let index = 0; index < 20; index += 1) {
    events.push(event({ artist: "Big Growth", track: "Song", daysAgo: 31 + (index % 20) }));
  }
  for (let index = 0; index < 50; index += 1) {
    events.push(event({ artist: "Big Growth", track: "Song", daysAgo: 1 + (index % 20) }));
  }
  events.push(event({ artist: "Tiny Growth", track: "Song", daysAgo: 31 }));
  for (let index = 0; index < 3; index += 1) {
    events.push(event({ artist: "Tiny Growth", track: "Song", daysAgo: 1 + index }));
  }

  const report = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: null,
  });

  assert.equal(report.recentMomentum[0]?.artistName, "Big Growth");
  assert.equal(report.recentMomentum[0]?.momentumDelta30d, 30);
  assert.equal(report.recentMomentum[1]?.artistName, "Tiny Growth");
  assert.equal(report.recentMomentum[1]?.momentumDelta30d, 2);
});

test("reports dormant favorites, rediscovery returns and MUSIC-01 cooldown eligibility without changing the underlying facts", () => {
  const events: DiscoveryHistoryEvent[] = [
    event({ artist: "Dormant", track: "Old Favorite", daysAgo: 800 }),
    event({ artist: "Dormant", track: "Old Favorite", daysAgo: 700 }),
    event({ artist: "Returned", track: "Return Song", daysAgo: 900 }),
    event({ artist: "Returned", track: "Return Song", daysAgo: 5 }),
    event({ artist: "Blocked", track: "Recent Song", daysAgo: 15 }),
  ];

  const report = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [
      { spotifyTrackId: "dormant-old-favorite", lastPlayedAt: ago(700) },
      { spotifyTrackId: "returned-return-song", lastPlayedAt: ago(5) },
      { spotifyTrackId: "blocked-recent-song", lastPlayedAt: ago(15) },
    ],
    playbackPolicy: { enabled: true, windowValue: 6, windowUnit: "MONTHS" },
    lastFmValidFrom: null,
    dormantDays: 365,
    rediscoveryGapDays: 180,
  });

  assert.equal(report.dormantFavorites[0]?.artistName, "Dormant");
  assert.equal(report.rediscoveryReturns[0]?.artistName, "Returned");
  assert.ok((report.rediscoveryReturns[0]?.rediscoveryGapDays ?? 0) >= 180);

  const eligibleIds = new Set(report.familiarCandidates.map((track) => track.spotifyTrackId));
  assert.equal(eligibleIds.has("dormant-old-favorite"), true);
  assert.equal(eligibleIds.has("returned-return-song"), false);
  assert.equal(eligibleIds.has("blocked-recent-song"), false);
  assert.equal(report.cooldown.blockedTrackCount, 2);
});
