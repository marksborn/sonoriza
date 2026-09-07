import assert from "node:assert/strict";
import test from "node:test";

import {
  addMusicRepeatWindow,
  buildMusicExposureEligibilityProjection,
  filterMusicCandidatesForExposureEligibility,
} from "./eligibility-anchor";
import type {
  MusicExposureShadowEvent,
  MusicExposureShadowReport,
  MusicExposureShadowScrobble,
} from "./shadow";

const base = new Date("2026-09-07T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

function event(index: number, input?: Partial<MusicExposureShadowEvent>): MusicExposureShadowEvent {
  const exposedAt = new Date(base.getTime() + index * day);
  return {
    eventKey: `run-${index}\u0000target-1\u0000spotify:A`,
    runId: `run-${index}`,
    targetPlaylistId: "target-1",
    targetName: "Avulsa",
    trackKey: "spotify:A",
    trackName: "Track A",
    artistName: "Artist A",
    position: 0,
    exposedAt,
    observationEndsAt: new Date(exposedAt.getTime() + day),
    usageEvidence: "SESSION_USED_NO_TRACK_MATCH",
    validExposure: true,
    confirmedConsumptionAt: null,
    ...input,
  };
}

function report(events: MusicExposureShadowEvent[], threshold = 4): MusicExposureShadowReport {
  return {
    threshold,
    publicationCount: events.length,
    exposureCount: events.length,
    validExposureCount: events.filter((row) => row.validExposure).length,
    confirmedConsumptionCount: events.filter((row) => row.confirmedConsumptionAt).length,
    thresholdTrackCount: 0,
    uniqueExposedTrackCount: 1,
    keepFilledBaselineSkippedCount: 0,
    sessionUsageUnconfirmedCount: 0,
    events,
    projections: [],
    targets: [],
  };
}

const policy = {
  enabled: true,
  windowValue: 30,
  windowUnit: "DAYS" as const,
};

test("N-1 valid exposures do not create an eligibility anchor", () => {
  const projection = buildMusicExposureEligibilityProjection({
    report: report([event(0), event(1), event(2)]),
    scrobbles: [],
    lastFmComplete: true,
    policy,
    asOf: new Date(base.getTime() + 3 * day),
  });

  assert.equal(projection.status, "READY");
  assert.equal(projection.anchors.length, 0);
  assert.equal(projection.activeTrackIds.size, 0);
});

test("N=4 valid unconfirmed exposures create SONORIZA_EXPOSURE cooldown without lastPlayedAt", () => {
  const projection = buildMusicExposureEligibilityProjection({
    report: report([event(0), event(1), event(2), event(3)]),
    scrobbles: [],
    lastFmComplete: true,
    policy,
    asOf: new Date(base.getTime() + 4 * day),
  });

  assert.equal(projection.anchors.length, 1);
  const anchor = projection.anchors[0]!;
  assert.equal(anchor.source, "SONORIZA_EXPOSURE");
  assert.equal(anchor.spotifyTrackId, "A");
  assert.equal(anchor.consecutiveUnconfirmedExposureCount, 4);
  assert.equal(anchor.anchorAt.toISOString(), event(3).exposedAt.toISOString());
  assert.equal(anchor.cooldownUntil.toISOString(), new Date(event(3).exposedAt.getTime() + 30 * day).toISOString());
  assert.equal(anchor.active, true);
  assert.equal("lastPlayedAt" in anchor, false);
});

test("later factual Last.fm scrobble resets the exposure streak", () => {
  const scrobbles: MusicExposureShadowScrobble[] = [
    {
      playedAt: new Date(base.getTime() + 3.5 * day),
      trackName: "Track A",
      artistName: "Artist A",
    },
  ];
  const projection = buildMusicExposureEligibilityProjection({
    report: report([event(0), event(1), event(2), event(3)]),
    scrobbles,
    lastFmComplete: true,
    policy,
    asOf: new Date(base.getTime() + 4 * day),
  });

  assert.equal(projection.anchors.length, 0);
  assert.equal(projection.activeTrackIds.size, 0);
});

test("incomplete Last.fm coverage abstains instead of treating absence as negative", () => {
  const projection = buildMusicExposureEligibilityProjection({
    report: report([event(0), event(1), event(2), event(3)]),
    scrobbles: [],
    lastFmComplete: false,
    policy,
    asOf: new Date(base.getTime() + 4 * day),
  });

  assert.equal(projection.status, "LASTFM_INCOMPLETE");
  assert.equal(projection.anchors.length, 0);
});

test("expired exposure anchor no longer blocks eligibility", () => {
  const projection = buildMusicExposureEligibilityProjection({
    report: report([event(0), event(1), event(2), event(3)]),
    scrobbles: [],
    lastFmComplete: true,
    policy: { enabled: true, windowValue: 2, windowUnit: "DAYS" },
    asOf: new Date(base.getTime() + 10 * day),
  });

  assert.equal(projection.anchors.length, 1);
  assert.equal(projection.anchors[0]?.active, false);
  assert.equal(projection.activeTrackIds.size, 0);
});

test("candidate filter removes only active exposure cooldown track identities", () => {
  const candidates = [
    {
      type: "MUSIC" as const,
      uri: "spotify:track:A",
      title: "A",
      subtitle: "Artist A",
      durationMs: 180000,
      spotifyTrackId: "A",
      primaryArtistId: "artist-a",
      albumId: "album-a",
    },
    {
      type: "MUSIC" as const,
      uri: "spotify:track:B",
      title: "B",
      subtitle: "Artist B",
      durationMs: 180000,
      spotifyTrackId: "B",
      primaryArtistId: "artist-b",
      albumId: "album-b",
    },
  ];

  const filtered = filterMusicCandidatesForExposureEligibility(
    candidates,
    new Set(["A"]),
    true,
  );
  assert.deepEqual(filtered.candidates.map((row) => row.spotifyTrackId), ["B"]);
  assert.equal(filtered.exposureCooldownSkippedCount, 1);
});

test("calendar units are added with month-end clamping", () => {
  assert.equal(
    addMusicRepeatWindow(new Date("2026-01-31T10:30:00.000Z"), 1, "MONTHS").toISOString(),
    "2026-02-28T10:30:00.000Z",
  );
});
