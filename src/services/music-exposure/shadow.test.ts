import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMusicExposureShadow,
  MUSIC_07_SHADOW_THRESHOLD_DEFAULT,
  type MusicExposureShadowPublication,
  type MusicExposureShadowScrobble,
  type MusicExposureShadowTrack,
} from "./shadow";

const base = new Date("2026-09-07T12:00:00.000Z");
const hour = 60 * 60 * 1000;

const trackA = track("spotify:A", "Track A", "Artist A", 0);
const trackB = track("spotify:B", "Track B", "Artist B", 1);
const trackC = track("spotify:C", "Track C", "Artist C", 2);

function at(hours: number): Date {
  return new Date(base.getTime() + hours * hour);
}

function track(
  trackKey: string,
  trackName: string,
  artistName: string,
  position: number,
): MusicExposureShadowTrack {
  return { trackKey, trackName, artistName, position };
}

function publication(input: Partial<MusicExposureShadowPublication> & {
  runId: string;
  publishedAt: Date;
  tracks: readonly MusicExposureShadowTrack[];
}): MusicExposureShadowPublication {
  return {
    runId: input.runId,
    targetPlaylistId: input.targetPlaylistId ?? "target-1",
    targetName: input.targetName ?? "Avulsa",
    updatePolicy: input.updatePolicy ?? "REBUILD_DAILY",
    publishedAt: input.publishedAt,
    simulation: input.simulation ?? false,
    status: input.status ?? "SUCCESS",
    applied: input.applied ?? true,
    tracks: input.tracks,
  };
}

function scrobble(
  playedAt: Date,
  trackName: string,
  artistName: string,
): MusicExposureShadowScrobble {
  return { playedAt, trackName, artistName };
}

test("Gate 2 excludes simulations, failed runs and unapplied rebuild publications", () => {
  const report = buildMusicExposureShadow({
    publications: [
      publication({
        runId: "sim",
        publishedAt: at(0),
        tracks: [trackA],
        simulation: true,
      }),
      publication({
        runId: "failed",
        publishedAt: at(1),
        tracks: [trackA],
        status: "FAILED",
      }),
      publication({
        runId: "not-applied",
        publishedAt: at(2),
        tracks: [trackA],
        applied: false,
      }),
      publication({
        runId: "real",
        publishedAt: at(3),
        tracks: [trackA, trackB],
      }),
    ],
    scrobbles: [scrobble(at(3.5), "Track B", "Artist B")],
    observedUntil: at(8),
  });

  assert.equal(report.publicationCount, 1);
  assert.equal(report.exposureCount, 2);
  assert.equal(report.validExposureCount, 2);
  assert.equal(report.confirmedConsumptionCount, 1);
  assert.deepEqual(
    report.events.map((event) => [event.trackKey, event.usageEvidence]),
    [
      ["spotify:A", "SESSION_USED_NO_TRACK_MATCH"],
      ["spotify:B", "TRACK_CONSUMED"],
    ],
  );
});

test("KEEP_FILLED uses the first measurable snapshot only as baseline and counts delta later", () => {
  const report = buildMusicExposureShadow({
    publications: [
      publication({
        runId: "keep-1",
        publishedAt: at(0),
        updatePolicy: "KEEP_FILLED",
        targetName: "Trabalho",
        tracks: [trackA, trackB],
      }),
      publication({
        runId: "keep-2",
        publishedAt: at(2),
        updatePolicy: "KEEP_FILLED",
        targetName: "Trabalho",
        tracks: [trackA, trackB, trackC],
      }),
    ],
    scrobbles: [scrobble(at(2.5), "Track B", "Artist B")],
    observedUntil: at(8),
  });

  assert.equal(report.keepFilledBaselineSkippedCount, 2);
  assert.equal(report.exposureCount, 1);
  assert.equal(report.validExposureCount, 1);
  assert.equal(report.events[0]?.trackKey, "spotify:C");
  assert.equal(report.events[0]?.usageEvidence, "SESSION_USED_NO_TRACK_MATCH");
});

test("KEEP_FILLED no-op can establish baseline without creating exposure", () => {
  const report = buildMusicExposureShadow({
    publications: [
      publication({
        runId: "keep-baseline-noop",
        publishedAt: at(0),
        updatePolicy: "KEEP_FILLED",
        targetName: "Trabalho",
        applied: false,
        tracks: [trackA, trackB],
      }),
      publication({
        runId: "keep-applied",
        publishedAt: at(2),
        updatePolicy: "KEEP_FILLED",
        targetName: "Trabalho",
        tracks: [trackA, trackB, trackC],
      }),
    ],
    scrobbles: [scrobble(at(2.5), "Track A", "Artist A")],
    observedUntil: at(8),
  });

  assert.equal(report.publicationCount, 2);
  assert.equal(report.keepFilledBaselineSkippedCount, 2);
  assert.equal(report.exposureCount, 1);
  assert.equal(report.events[0]?.trackKey, "spotify:C");
});

test("absence of Last.fm session evidence never becomes a valid operational exposure", () => {
  const report = buildMusicExposureShadow({
    publications: [
      publication({ runId: "r1", publishedAt: at(0), tracks: [trackA] }),
      publication({ runId: "r2", publishedAt: at(2), tracks: [trackA] }),
      publication({ runId: "r3", publishedAt: at(4), tracks: [trackA] }),
      publication({ runId: "r4", publishedAt: at(6), tracks: [trackA] }),
    ],
    scrobbles: [],
    observedUntil: at(10),
  });

  assert.equal(report.exposureCount, 4);
  assert.equal(report.validExposureCount, 0);
  assert.equal(report.sessionUsageUnconfirmedCount, 4);
  assert.equal(report.thresholdTrackCount, 0);
  assert.equal(report.projections[0]?.wouldEnterCooldown, false);
  assert.equal(report.projections[0]?.consecutiveUnconfirmedExposureCount, 0);
});

test("N-1 valid unconfirmed exposures stay below the default threshold", () => {
  const publications: MusicExposureShadowPublication[] = [];
  const scrobbles: MusicExposureShadowScrobble[] = [];

  for (let index = 0; index < MUSIC_07_SHADOW_THRESHOLD_DEFAULT - 1; index += 1) {
    const anchor = track(
      `spotify:anchor-${index}`,
      `Anchor ${index}`,
      "Anchor Artist",
      1,
    );
    publications.push(
      publication({
        runId: `r-${index}`,
        publishedAt: at(index * 2),
        tracks: [trackA, anchor],
      }),
    );
    scrobbles.push(
      scrobble(at(index * 2 + 0.5), anchor.trackName, anchor.artistName),
    );
  }

  const report = buildMusicExposureShadow({
    publications,
    scrobbles,
    observedUntil: at(12),
  });
  const projection = report.projections.find((row) => row.trackKey === "spotify:A");

  assert.equal(projection?.consecutiveUnconfirmedExposureCount, 3);
  assert.equal(projection?.wouldEnterCooldown, false);
  assert.equal(report.thresholdTrackCount, 0);
});

test("N=4 valid unconfirmed exposures only report a would-enter-cooldown shadow result", () => {
  const publications: MusicExposureShadowPublication[] = [];
  const scrobbles: MusicExposureShadowScrobble[] = [];

  for (let index = 0; index < MUSIC_07_SHADOW_THRESHOLD_DEFAULT; index += 1) {
    const anchor = track(
      `spotify:anchor-${index}`,
      `Anchor ${index}`,
      "Anchor Artist",
      1,
    );
    publications.push(
      publication({
        runId: `r-${index}`,
        publishedAt: at(index * 2),
        tracks: [trackA, anchor],
      }),
    );
    scrobbles.push(
      scrobble(at(index * 2 + 0.5), anchor.trackName, anchor.artistName),
    );
  }

  const report = buildMusicExposureShadow({
    publications,
    scrobbles,
    observedUntil: at(12),
  });
  const projection = report.projections.find((row) => row.trackKey === "spotify:A");

  assert.equal(projection?.consecutiveUnconfirmedExposureCount, 4);
  assert.equal(projection?.wouldEnterCooldown, true);
  assert.equal(projection?.thresholdReachedAt?.toISOString(), at(6).toISOString());
  assert.equal(report.thresholdTrackCount, 1);
});

test("a real matching scrobble resets the consecutive exposure projection", () => {
  const publications: MusicExposureShadowPublication[] = [];
  const scrobbles: MusicExposureShadowScrobble[] = [];

  for (let index = 0; index < 4; index += 1) {
    const anchor = track(
      `spotify:anchor-${index}`,
      `Anchor ${index}`,
      "Anchor Artist",
      1,
    );
    publications.push(
      publication({
        runId: `r-${index}`,
        publishedAt: at(index * 2),
        tracks: [trackA, anchor],
      }),
    );
    scrobbles.push(
      index === 3
        ? scrobble(at(index * 2 + 0.5), trackA.trackName, trackA.artistName)
        : scrobble(at(index * 2 + 0.5), anchor.trackName, anchor.artistName),
    );
  }

  const report = buildMusicExposureShadow({
    publications,
    scrobbles,
    observedUntil: at(12),
  });
  const projection = report.projections.find((row) => row.trackKey === "spotify:A");

  assert.equal(projection?.validExposureCount, 4);
  assert.equal(projection?.consecutiveUnconfirmedExposureCount, 0);
  assert.equal(projection?.wouldEnterCooldown, false);
  assert.equal(projection?.lastConfirmedConsumptionAt?.toISOString(), at(6.5).toISOString());
});

test("same run/target/track is idempotent inside the shadow report", () => {
  const row = publication({
    runId: "same-run",
    publishedAt: at(0),
    tracks: [trackA, trackA, trackB],
  });

  const report = buildMusicExposureShadow({
    publications: [row, row],
    scrobbles: [scrobble(at(0.5), "Track B", "Artist B")],
    observedUntil: at(4),
  });

  assert.equal(report.publicationCount, 1);
  assert.equal(
    report.events.filter((event) => event.trackKey === "spotify:A").length,
    1,
  );
  assert.equal(
    report.events.filter((event) => event.trackKey === "spotify:B").length,
    1,
  );
});

test("normalization aligns harmless Last.fm spelling differences without fuzzy matching", () => {
  const report = buildMusicExposureShadow({
    publications: [
      publication({
        runId: "normalized",
        publishedAt: at(0),
        tracks: [track("spotify:cafe", "Café & Rock", "Ártist", 0)],
      }),
    ],
    scrobbles: [scrobble(at(0.5), "Cafe and Rock", "Artist")],
    observedUntil: at(4),
  });

  assert.equal(report.confirmedConsumptionCount, 1);
  assert.equal(report.events[0]?.usageEvidence, "TRACK_CONSUMED");
});
