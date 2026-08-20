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

test("Gate 1.1 excludes epoch placeholders from any source and keeps explicit/inferred skips separate from plays", () => {
  const events: DiscoveryHistoryEvent[] = [
    {
      ...event({
        artist: "Synthetic",
        track: "Epoch",
        daysAgo: 1,
        source: "SPOTIFY_EXTENDED_HISTORY",
      }),
      playedAt: new Date("1970-01-01T00:00:05.000Z"),
    },
    {
      ...event({ artist: "Legacy", track: "Pre Coverage", daysAgo: 1 }),
      playedAt: new Date("2010-01-01T00:00:00.000Z"),
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
  assert.equal(report.coverage.invalidSyntheticEpochEventsExcluded, 1);
  assert.equal(report.coverage.invalidLegacyLastFmExcluded, 1);
  assert.equal(report.coverage.firstPlayedAt?.getFullYear(), 2025);
  assert.equal(report.coverage.extendedEvidenceEvents, 1);
  assert.equal(report.coverage.msPlayedEvidenceEvents, 1);
  assert.equal(report.coverage.explicitSkipEvents, 1);
  assert.equal(report.coverage.inferredSkipSignals, 1);
  assert.equal(report.coverage.pendingInferredSkipSignals, 1);

  const artist = report.topArtistsHistorical[0];
  assert.equal(artist?.artistName, "Artist A");
  assert.equal(artist?.playCount, 2);
  assert.equal(artist?.extendedEvidenceCount, 1);
  assert.equal(artist?.explicitSkipCount, 1);
  assert.equal(artist?.explicitSkipRate, 1);
  assert.equal(artist?.inferredSkipCount, 1);

  const track = report.topTracksHistorical[0];
  assert.equal(track?.playCount, 2);
  assert.equal(track?.explicitSkipCount, 1);
  assert.equal(track?.explicitSkipRate, 1);
  assert.equal(track?.inferredSkipCount, 1);
});

test("canonicalizes confirmed artist aliases and removes known non-musical Spotify utility rows from profile rankings", () => {
  const events: DiscoveryHistoryEvent[] = [
    event({
      artist: "Detonautas Roque Clube",
      track: "Outro Olhar",
      daysAgo: 500,
      spotifyTrackId: "detonautas-old",
    }),
    event({
      artist: "Detonautas",
      track: "Você Me Faz Tão Bem",
      daysAgo: 5,
      spotifyTrackId: "detonautas-new",
    }),
    event({
      artist: "Spotify",
      track: "Hoje é quarta-feira - Caminho Diário",
      daysAgo: 100,
      spotifyTrackId: "spotify-daily",
      source: "SPOTIFY_EXTENDED_HISTORY",
      metadata: {
        spotifyExtendedHistory: { msPlayed: 60_000, explicitSkip: false },
      },
    }),
  ];

  const report = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: null,
  });

  assert.equal(report.coverage.artistAliasEventsCanonicalized, 1);
  assert.equal(report.coverage.nonMusicalProfileEventsExcluded, 1);
  assert.equal(report.topArtistsHistorical.length, 1);
  assert.equal(report.topArtistsHistorical[0]?.artistName, "Detonautas Roque Clube");
  assert.equal(report.topArtistsHistorical[0]?.playCount, 2);
  assert.equal(
    report.topTracksHistorical.some((track) => track.artistName === "Spotify"),
    false,
  );
});

test("momentum requires recurrence across at least three listening days so a short binge is not treated as sustained momentum", () => {
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
  for (let index = 0; index < 30; index += 1) {
    events.push(event({ artist: "Two Day Burst", track: `Song ${index}`, daysAgo: 1 + (index % 2) }));
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
  assert.equal(
    report.recentMomentum.some((artist) => artist.artistName === "Two Day Burst"),
    false,
  );
  const burst = report.topArtists30d.find((artist) => artist.artistName === "Two Day Burst");
  assert.equal(burst?.plays30d, 30);
  assert.equal(burst?.listeningDays30d, 2);
});

test("rediscovery requires prior affinity and repeat recent evidence instead of ranking a single ancient return by gap alone", () => {
  const events: DiscoveryHistoryEvent[] = [];
  for (let index = 0; index < 12; index += 1) {
    events.push(
      event({
        artist: "Strong Return",
        track: `Old ${index}`,
        daysAgo: 900 + index,
        spotifyTrackId: `strong-old-${index}`,
      }),
    );
  }
  events.push(
    event({ artist: "Strong Return", track: "New A", daysAgo: 5, spotifyTrackId: "strong-new-a" }),
    event({ artist: "Strong Return", track: "New B", daysAgo: 3, spotifyTrackId: "strong-new-b" }),
    event({ artist: "Ancient One-Off", track: "Old", daysAgo: 4_500, spotifyTrackId: "oneoff-old" }),
    event({ artist: "Ancient One-Off", track: "Return", daysAgo: 4, spotifyTrackId: "oneoff-new" }),
  );

  const report = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [],
    playbackPolicy: null,
    lastFmValidFrom: null,
    rediscoveryGapDays: 180,
  });

  assert.equal(report.rediscoveryReturns[0]?.artistName, "Strong Return");
  assert.equal(report.rediscoveryReturns[0]?.priorPlayCount, 12);
  assert.equal(report.rediscoveryReturns[0]?.plays30d, 2);
  assert.equal(
    report.rediscoveryReturns.some((artist) => artist.artistName === "Ancient One-Off"),
    false,
  );
});

test("reports dormant favorites and uses the reconciled timeline as a safe cooldown fallback when TrackListeningState is missing", () => {
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
    trackStates: [],
    playbackPolicy: { enabled: true, windowValue: 6, windowUnit: "MONTHS" },
    lastFmValidFrom: null,
    dormantDays: 365,
    rediscoveryGapDays: 180,
  });

  assert.equal(report.dormantFavorites[0]?.artistName, "Dormant");

  const eligibleIds = new Set(report.familiarCandidates.map((track) => track.spotifyTrackId));
  assert.equal(eligibleIds.has("dormant-old-favorite"), true);
  assert.equal(eligibleIds.has("returned-return-song"), false);
  assert.equal(eligibleIds.has("blocked-recent-song"), false);
  assert.equal(report.cooldown.blockedTrackCount, 2);
  assert.equal(report.cooldown.timelineFallbackTrackCount, 3);

  const blocked = report.topTracksHistorical.find(
    (track) => track.spotifyTrackId === "blocked-recent-song",
  );
  assert.equal(blocked?.cooldownLastPlayedSource, "TIMELINE");
  assert.equal(blocked?.cooldownEligible, false);
});

test("uses a newer timeline fact over a stale TrackListeningState for cooldown safety", () => {
  const events: DiscoveryHistoryEvent[] = [
    event({ artist: "State Lag", track: "Recent", daysAgo: 2, spotifyTrackId: "state-lag" }),
  ];

  const report = buildMusicDiscoveryProfile({
    asOf: AS_OF,
    events,
    inferredSkips: [],
    trackStates: [{ spotifyTrackId: "state-lag", lastPlayedAt: ago(20) }],
    playbackPolicy: { enabled: true, windowValue: 10, windowUnit: "DAYS" },
    lastFmValidFrom: null,
  });

  const track = report.topTracksHistorical[0];
  assert.equal(track?.cooldownLastPlayedSource, "TIMELINE");
  assert.equal(track?.cooldownLastPlayedAt?.toISOString(), ago(2).toISOString());
  assert.equal(track?.cooldownEligible, false);
  assert.equal(report.cooldown.timelineOverrideTrackCount, 1);
  assert.equal(report.cooldown.blockedTrackCount, 1);
});
