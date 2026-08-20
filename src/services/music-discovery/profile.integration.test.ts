import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { getMusicDiscoveryProfile } from "./profile";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest("reads the reconciled timeline without mutating discovery/history state", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: { email: `discovery-profile-${suffix}@example.test` },
  });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } });
  });

  const validFrom = new Date("2013-11-12T12:17:22.000Z");
  await prisma.lastFmBackfillRun.create({
    data: {
      userId: user.id,
      username: "fixture-user",
      status: "SUCCESS",
      from: validFrom,
      to: new Date("2026-08-15T00:00:00.000Z"),
      acceptedEvents: 2,
      insertedEvents: 2,
      finishedAt: new Date("2026-08-15T00:00:01.000Z"),
    },
  });

  await prisma.trackListeningEvent.createMany({
    data: [
      {
        userId: user.id,
        trackName: "Synthetic",
        artistName: "Legacy",
        playedAt: new Date("1970-01-01T00:00:01.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `legacy-${suffix}`,
      },
      {
        userId: user.id,
        spotifyTrackId: "track-a",
        spotifyUri: "spotify:track:track-a",
        trackName: "Track A",
        artistName: "Artist A",
        albumName: "Album A",
        playedAt: new Date("2025-01-10T12:00:00.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `lastfm-a-${suffix}`,
      },
      {
        userId: user.id,
        spotifyTrackId: "track-a",
        spotifyUri: "spotify:track:track-a",
        trackName: "Track A",
        artistName: "Artist A",
        albumName: "Album A",
        playedAt: new Date("2026-08-10T12:00:00.000Z"),
        source: "SPOTIFY_EXTENDED_HISTORY",
        sourceEventKey: `extended-a-${suffix}`,
        metadata: {
          spotifyExtendedHistory: {
            msPlayed: 18_000,
            skipped: true,
            explicitSkip: true,
            reasonStart: "trackdone",
            reasonEnd: "fwdbtn",
          },
        },
      },
    ],
  });

  await prisma.trackListeningState.create({
    data: {
      userId: user.id,
      spotifyTrackId: "track-a",
      spotifyUri: "spotify:track:track-a",
      lastPlayedAt: new Date("2026-08-10T12:00:00.000Z"),
    },
  });
  await prisma.musicPlaybackPolicy.create({
    data: {
      userId: user.id,
      enabled: true,
      windowValue: 6,
      windowUnit: "MONTHS",
    },
  });
  await prisma.musicPreferenceSignal.create({
    data: {
      userId: user.id,
      spotifyTrackId: "track-a",
      spotifyUri: "spotify:track:track-a",
      type: "INFERRED_SKIP",
      sourceGenerationRunId: `run-${suffix}`,
      targetPlaylistId: `target-${suffix}`,
      position: 1,
      confidence: 1,
      inferredAt: new Date("2026-08-11T12:00:00.000Z"),
    },
  });

  const before = await Promise.all([
    prisma.trackListeningEvent.count({ where: { userId: user.id } }),
    prisma.trackListeningState.count({ where: { userId: user.id } }),
    prisma.musicPreferenceSignal.count({ where: { userId: user.id } }),
  ]);

  const report = await getMusicDiscoveryProfile(user.id, {
    asOf: new Date("2026-08-20T18:00:00.000Z"),
    topN: 5,
  });

  const after = await Promise.all([
    prisma.trackListeningEvent.count({ where: { userId: user.id } }),
    prisma.trackListeningState.count({ where: { userId: user.id } }),
    prisma.musicPreferenceSignal.count({ where: { userId: user.id } }),
  ]);

  assert.deepEqual(after, before);
  assert.equal(report.coverage.totalCanonicalEvents, 2);
  assert.equal(report.coverage.invalidLegacyLastFmExcluded, 1);
  assert.equal(report.coverage.extendedEvidenceEvents, 1);
  assert.equal(report.coverage.msPlayedEvidenceEvents, 1);
  assert.equal(report.coverage.explicitSkipEvents, 1);
  assert.equal(report.coverage.inferredSkipSignals, 1);
  assert.equal(report.coverage.pendingInferredSkipSignals, 1);
  assert.equal(report.topArtistsHistorical[0]?.artistName, "Artist A");
  assert.equal(report.topTracksHistorical[0]?.spotifyTrackId, "track-a");
  assert.equal(report.topTracksHistorical[0]?.cooldownEligible, false);
});
