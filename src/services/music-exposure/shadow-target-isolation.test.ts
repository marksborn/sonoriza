import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMusicExposureShadow,
  type MusicExposureShadowPublication,
  type MusicExposureShadowScrobble,
  type MusicExposureShadowTrack,
} from "./shadow";

const base = new Date("2026-09-07T12:00:00.000Z");
const hour = 60 * 60 * 1000;
const trackA = track("spotify:A", "Track A", "Artist A", 0);

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

function publication(input: {
  runId: string;
  targetPlaylistId: string;
  targetName: string;
  publishedAt: Date;
  sessionTrack: MusicExposureShadowTrack;
}): MusicExposureShadowPublication {
  return {
    runId: input.runId,
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    updatePolicy: "REBUILD_DAILY",
    publishedAt: input.publishedAt,
    simulation: false,
    status: "SUCCESS",
    applied: true,
    tracks: [trackA, input.sessionTrack],
  };
}

function scrobble(
  playedAt: Date,
  trackName: string,
  artistName: string,
): MusicExposureShadowScrobble {
  return { playedAt, trackName, artistName };
}

test("N-1 + 1 across targets never forms N in shadow projections", () => {
  const carroSession1 = track("spotify:carro-1", "Carro Session 1", "Witness", 1);
  const carroSession2 = track("spotify:carro-2", "Carro Session 2", "Witness", 1);
  const avulsaSession1 = track("spotify:avulsa-1", "Avulsa Session 1", "Witness", 1);
  const avulsaSession2 = track("spotify:avulsa-2", "Avulsa Session 2", "Witness", 1);

  const report = buildMusicExposureShadow({
    publications: [
      publication({
        runId: "carro-1",
        targetPlaylistId: "carro",
        targetName: "Carro",
        publishedAt: at(0),
        sessionTrack: carroSession1,
      }),
      publication({
        runId: "carro-2",
        targetPlaylistId: "carro",
        targetName: "Carro",
        publishedAt: at(2),
        sessionTrack: carroSession2,
      }),
      publication({
        runId: "avulsa-1",
        targetPlaylistId: "avulsa",
        targetName: "Avulsa",
        publishedAt: at(4),
        sessionTrack: avulsaSession1,
      }),
      publication({
        runId: "avulsa-2",
        targetPlaylistId: "avulsa",
        targetName: "Avulsa",
        publishedAt: at(6),
        sessionTrack: avulsaSession2,
      }),
    ],
    scrobbles: [
      scrobble(at(0.5), carroSession1.trackName, carroSession1.artistName),
      scrobble(at(2.5), carroSession2.trackName, carroSession2.artistName),
      scrobble(at(4.5), avulsaSession1.trackName, avulsaSession1.artistName),
      scrobble(at(6.5), avulsaSession2.trackName, avulsaSession2.artistName),
    ],
    observedUntil: at(10),
    threshold: 4,
  });

  const trackAProjections = report.projections
    .filter((row) => row.trackKey === "spotify:A")
    .sort((left, right) => left.targetPlaylistId.localeCompare(right.targetPlaylistId));

  assert.equal(trackAProjections.length, 2);
  assert.deepEqual(
    trackAProjections.map((row) => ({
      targetPlaylistId: row.targetPlaylistId,
      streak: row.consecutiveUnconfirmedExposureCount,
      wouldEnterCooldown: row.wouldEnterCooldown,
    })),
    [
      {
        targetPlaylistId: "avulsa",
        streak: 2,
        wouldEnterCooldown: false,
      },
      {
        targetPlaylistId: "carro",
        streak: 2,
        wouldEnterCooldown: false,
      },
    ],
  );
  assert.equal(report.thresholdTrackCount, 0);
  assert.equal(report.uniqueExposedTrackCount, 5);
});

test("the same track may reach the threshold in one target without contaminating another", () => {
  const publications: MusicExposureShadowPublication[] = [];
  const scrobbles: MusicExposureShadowScrobble[] = [];

  for (let index = 0; index < 4; index += 1) {
    const witness = track(
      `spotify:carro-witness-${index}`,
      `Carro Witness ${index}`,
      "Witness",
      1,
    );
    publications.push(
      publication({
        runId: `carro-${index}`,
        targetPlaylistId: "carro",
        targetName: "Carro",
        publishedAt: at(index * 2),
        sessionTrack: witness,
      }),
    );
    scrobbles.push(scrobble(at(index * 2 + 0.5), witness.trackName, witness.artistName));
  }

  const avulsaWitness = track("spotify:avulsa-witness", "Avulsa Witness", "Witness", 1);
  publications.push(
    publication({
      runId: "avulsa-1",
      targetPlaylistId: "avulsa",
      targetName: "Avulsa",
      publishedAt: at(9),
      sessionTrack: avulsaWitness,
    }),
  );
  scrobbles.push(scrobble(at(9.5), avulsaWitness.trackName, avulsaWitness.artistName));

  const report = buildMusicExposureShadow({
    publications,
    scrobbles,
    observedUntil: at(12),
    threshold: 4,
  });

  const projections = report.projections.filter((row) => row.trackKey === "spotify:A");
  const carro = projections.find((row) => row.targetPlaylistId === "carro");
  const avulsa = projections.find((row) => row.targetPlaylistId === "avulsa");

  assert.equal(carro?.consecutiveUnconfirmedExposureCount, 4);
  assert.equal(carro?.wouldEnterCooldown, true);
  assert.equal(avulsa?.consecutiveUnconfirmedExposureCount, 1);
  assert.equal(avulsa?.wouldEnterCooldown, false);
  assert.equal(report.thresholdTrackCount, 1);
});
