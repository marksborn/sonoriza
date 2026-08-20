import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import type { SpotifyExtendedMusicEvent } from "./parser";
import { buildSpotifyExtendedPersistenceManifest } from "./persistence-manifest";
import { buildSpotifyExtendedPersistencePlan } from "./persistence-plan";
import { applySpotifyExtendedHistory } from "./persistence-writer";
import { reconcileSpotifyExtendedHistory } from "./reconcile";

const PACKAGE_SHA = "c".repeat(64);

test("HISTORY-02 stale INSERT_NEW is guarded when Last.fm appears after manifest freeze", async () => {
  const user = await prisma.user.create({
    data: { email: `history02-drift-${randomUUID()}@example.test` },
  });

  try {
    const event = spotifyEvent();
    const frozenReconciliation = reconcileSpotifyExtendedHistory([event], []);
    const frozenPlan = buildSpotifyExtendedPersistencePlan(
      PACKAGE_SHA,
      frozenReconciliation,
    );

    assert.equal(frozenPlan.summary.insertNew, 1);
    const manifest = buildSpotifyExtendedPersistenceManifest(user.id, frozenPlan);

    // Canonical history drifts after the dry-run/manifest: the same play is now
    // represented by Last.fm. The stale manifest must not create a second event.
    await prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        trackName: event.trackName,
        artistName: event.artistName,
        albumName: event.albumName,
        playedAt: new Date(event.estimatedStartedAt.getTime() + 30_000),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: "lastfm-arrived-after-freeze",
      },
    });

    const result = await applySpotifyExtendedHistory({
      userId: user.id,
      packageSha256: PACKAGE_SHA,
      expectedPackageSha256: PACKAGE_SHA,
      expectedPlanHash: frozenPlan.planHash,
      expectedManifestHash: manifest.manifestHash,
      manifest,
      musicEvents: [event],
      client: prisma,
      batchSize: 1,
    });

    assert.equal(result.insertedEvents, 0);
    assert.equal(result.duplicateEvents, 1);
    assert.equal(result.enrichedEvents, 0);

    assert.equal(
      await prisma.trackListeningEvent.count({
        where: { userId: user.id, source: "SPOTIFY_EXTENDED_HISTORY" },
      }),
      0,
      "stale frozen insert must not create a cross-source duplicate",
    );

    assert.equal(
      await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
      1,
    );

    assert.equal(
      await prisma.trackListeningState.count({ where: { userId: user.id } }),
      0,
      "drift guard must not mutate MUSIC-01 cooldown state",
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

function spotifyEvent(): SpotifyExtendedMusicEvent {
  const estimatedStartedAt = new Date("2026-08-18T10:00:00.000Z");
  const msPlayed = 180_000;

  return {
    sourceFile: "fixture.json",
    sourceIndex: 0,
    endedAt: new Date(estimatedStartedAt.getTime() + msPlayed),
    estimatedStartedAt,
    msPlayed,
    spotifyTrackUri: "spotify:track:drifttrack",
    spotifyTrackId: "drifttrack",
    trackName: "Drift   Track",
    artistName: "Drift Artist",
    albumName: "Drift Album",
    reasonStart: "clickrow",
    reasonEnd: "trackdone",
    skipped: false,
    offline: false,
    offlineTimestamp: null,
    incognitoMode: false,
    sourceEventKey: "extended-drift-track",
  };
}