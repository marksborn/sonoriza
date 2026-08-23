import assert from "node:assert/strict";
import test from "node:test";

import {
  extractDiscoveryExposures,
  measureDiscoveryConversion,
  type DiscoveryExposure,
  type DiscoveryListeningEventLike,
} from "./conversion";

const EXPOSED = new Date("2026-08-01T12:00:00.000Z");

function exposure(overrides: Partial<DiscoveryExposure> = {}): DiscoveryExposure {
  return {
    runId: "run-1",
    exposedAt: EXPOSED,
    targetPlaylistId: "target-1",
    targetName: "Trabalho",
    discoveryUri: "spotify:track:abc123",
    spotifyTrackId: "abc123",
    discoveryTitle: "New Song",
    discoveryArtist: "New Artist",
    candidateKey: null,
    historyClass: null,
    pathLabel: null,
    resolutionReason: null,
    isrc: null,
    adjustedScore: 71.2,
    ...overrides,
  };
}

function event(
  at: string,
  overrides: Partial<DiscoveryListeningEventLike> = {},
): DiscoveryListeningEventLike {
  return {
    spotifyTrackId: "abc123",
    spotifyUri: "spotify:track:abc123",
    trackName: "New Song",
    artistName: "New Artist",
    isrc: null,
    playedAt: new Date(at),
    source: "SPOTIFY_RECENTLY_PLAYED",
    ...overrides,
  };
}

test("extracts only applied Gate 5H replacements from GenerationRun summary", () => {
  const exposures = extractDiscoveryExposures({
    id: "run-1",
    startedAt: new Date("2026-08-01T11:59:00.000Z"),
    finishedAt: EXPOSED,
    summary: {
      discoveryRuntime: {
        gate5h: {
          applied: true,
          evidence: {
            replacements: [
              {
                targetPlaylistId: "target-1",
                targetName: "Trabalho",
                discoveryUri: "spotify:track:abc123",
                discoveryTitle: "New Song",
                discoveryArtist: "New Artist",
                adjustedScore: 71.2,
                candidateKey: "candidate-1",
                pathLabel: "LASTFM_SIMILAR_TRACK",
                historyClass: "NEW_TRACK_KNOWN_ARTIST",
                resolutionReason: "EXACT",
                isrc: "US-ABC-12-34567",
              },
            ],
          },
        },
      },
    },
  });

  assert.equal(exposures.length, 1);
  assert.equal(exposures[0]!.spotifyTrackId, "abc123");
  assert.equal(exposures[0]!.isrc, "USABC1234567");
  assert.equal(exposures[0]!.pathLabel, "LASTFM_SIMILAR_TRACK");
  assert.equal(exposures[0]!.exposedAt.toISOString(), EXPOSED.toISOString());
});

test("ignores Gate 5H summaries that abstained or were not applied", () => {
  const exposures = extractDiscoveryExposures({
    id: "run-1",
    startedAt: EXPOSED,
    finishedAt: EXPOSED,
    summary: {
      discoveryRuntime: {
        gate5h: {
          applied: false,
          evidence: {
            replacements: [
              {
                discoveryUri: "spotify:track:abc123",
                discoveryTitle: "New Song",
              },
            ],
          },
        },
      },
    },
  });
  assert.deepEqual(exposures, []);
});

test("measures play, replay, artist exploration and long-term affinity", () => {
  const report = measureDiscoveryConversion({
    exposures: [exposure()],
    listeningEvents: [
      event("2026-08-02T12:00:00.000Z"),
      event("2026-08-03T12:00:00.000Z"),
      event("2026-08-10T12:00:00.000Z"),
      event("2026-08-05T12:00:00.000Z", {
        spotifyTrackId: "other-track",
        spotifyUri: "spotify:track:other-track",
        trackName: "Another Song",
      }),
    ],
    asOf: new Date("2026-09-10T12:00:00.000Z"),
  });

  assert.equal(report.exposureCount, 1);
  assert.equal(report.uniqueDiscoveryCount, 1);
  assert.equal(report.playedCount, 1);
  assert.equal(report.replayedCount, 1);
  assert.equal(report.artistExploredCount, 1);
  assert.equal(report.longTermAffinityCount, 1);
  assert.equal(report.candidates[0]!.playsAfterDiscovery, 3);
  assert.equal(report.candidates[0]!.distinctListeningDays, 3);
  assert.deepEqual(report.candidates[0]!.matchSources, ["SPOTIFY_TRACK_ID"]);
});

test("uses ISRC for a different provider track id but refuses text-only collapse when both ids exist", () => {
  const withIsrc = measureDiscoveryConversion({
    exposures: [exposure({ isrc: "USABC1234567" })],
    listeningEvents: [
      event("2026-08-02T12:00:00.000Z", {
        spotifyTrackId: "different-release",
        spotifyUri: "spotify:track:different-release",
        isrc: "US-ABC-12-34567",
      }),
    ],
    asOf: new Date("2026-08-03T12:00:00.000Z"),
  });
  assert.equal(withIsrc.playedCount, 1);
  assert.deepEqual(withIsrc.candidates[0]!.matchSources, ["ISRC"]);

  const withoutIsrc = measureDiscoveryConversion({
    exposures: [exposure()],
    listeningEvents: [
      event("2026-08-02T12:00:00.000Z", {
        spotifyTrackId: "different-recording",
        spotifyUri: "spotify:track:different-recording",
      }),
    ],
    asOf: new Date("2026-08-03T12:00:00.000Z"),
  });
  assert.equal(withoutIsrc.playedCount, 0);
});

test("allows conservative artist/title matching for id-less Last.fm-style evidence", () => {
  const report = measureDiscoveryConversion({
    exposures: [exposure()],
    listeningEvents: [
      event("2026-08-02T12:00:00.000Z", {
        spotifyTrackId: null,
        spotifyUri: null,
        source: "LASTFM_SCROBBLE",
      }),
    ],
    asOf: new Date("2026-08-03T12:00:00.000Z"),
  });
  assert.equal(report.playedCount, 1);
  assert.deepEqual(report.candidates[0]!.matchSources, ["IDLESS_TITLE_ARTIST"]);
});

test("does not label a fresh unplayed discovery as NEVER_PLAYED before maturity", () => {
  const fresh = measureDiscoveryConversion({
    exposures: [exposure()],
    listeningEvents: [],
    asOf: new Date("2026-08-05T12:00:00.000Z"),
  });
  assert.equal(fresh.candidates[0]!.matureForNeverPlayed, false);
  assert.equal(fresh.candidates[0]!.neverPlayed, false);
  assert.equal(fresh.matureNeverPlayedEligibleCount, 0);

  const mature = measureDiscoveryConversion({
    exposures: [exposure()],
    listeningEvents: [],
    asOf: new Date("2026-08-20T12:00:00.000Z"),
  });
  assert.equal(mature.candidates[0]!.matureForNeverPlayed, true);
  assert.equal(mature.candidates[0]!.neverPlayed, true);
  assert.equal(mature.neverPlayedCount, 1);
});

test("deduplicates repeated exposures of the same discovery", () => {
  const report = measureDiscoveryConversion({
    exposures: [
      exposure({ runId: "run-1", exposedAt: EXPOSED, targetName: "Trabalho" }),
      exposure({
        runId: "run-2",
        exposedAt: new Date("2026-08-04T12:00:00.000Z"),
        targetName: "Academia",
      }),
    ],
    listeningEvents: [event("2026-08-05T12:00:00.000Z")],
    asOf: new Date("2026-08-06T12:00:00.000Z"),
  });

  assert.equal(report.exposureCount, 2);
  assert.equal(report.uniqueDiscoveryCount, 1);
  assert.equal(report.playedCount, 1);
  assert.equal(report.candidates[0]!.exposureCount, 2);
  assert.deepEqual(report.candidates[0]!.targetNames, ["Trabalho", "Academia"]);
});
