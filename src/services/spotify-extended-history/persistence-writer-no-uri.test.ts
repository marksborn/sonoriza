import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import type { SpotifyExtendedMusicEvent } from "./parser";
import { buildSpotifyExtendedPersistenceManifest } from "./persistence-manifest";
import { buildSpotifyExtendedPersistencePlan } from "./persistence-plan";
import { applySpotifyExtendedHistory } from "./persistence-writer";
import {
  reconcileSpotifyExtendedHistory,
  type ExistingListeningEvent,
} from "./reconcile";

const PACKAGE_SHA = "c".repeat(64);

test("HISTORY-02 writer persists URI-less music and remains idempotent", async () => {
  const user = await prisma.user.create({
    data: { email: `history02-no-uri-${randomUUID()}@example.test` },
  });

  try {
    const exportEvent = noUriEvent(
      "new",
      "URI-less Artist",
      "URI-less Track",
      "URI-less Album",
      new Date("2026-08-18T11:00:00Z"),
    );

    const reconciliation = reconcileSpotifyExtendedHistory([exportEvent], []);
    assert.equal(reconciliation.entries[0]?.classification, "NEW_UNCOVERED_EVENT");

    const plan = buildSpotifyExtendedPersistencePlan(PACKAGE_SHA, reconciliation);
    const manifest = buildSpotifyExtendedPersistenceManifest(user.id, plan);

    assert.deepEqual(plan.summary, {
      insertNew: 1,
      enrichExisting: 0,
      quarantineConflict: 0,
      noopAlreadyEnriched: 0,
    });

    const first = await applySpotifyExtendedHistory({
      userId: user.id,
      packageSha256: PACKAGE_SHA,
      expectedPackageSha256: PACKAGE_SHA,
      expectedPlanHash: plan.planHash,
      expectedManifestHash: manifest.manifestHash,
      manifest,
      musicEvents: [exportEvent],
      client: prisma,
    });

    assert.equal(first.insertedEvents, 1);
    assert.equal(first.duplicateEvents, 0);

    const inserted = await prisma.trackListeningEvent.findFirstOrThrow({
      where: {
        userId: user.id,
        sourceEventKey: exportEvent.sourceEventKey,
      },
      select: {
        source: true,
        spotifyTrackId: true,
        spotifyUri: true,
        trackName: true,
        artistName: true,
        albumName: true,
        playedAt: true,
        metadata: true,
      },
    });

    assert.equal(inserted.source, "SPOTIFY_EXTENDED_HISTORY");
    assert.equal(inserted.spotifyTrackId, null);
    assert.equal(inserted.spotifyUri, null);
    assert.equal(inserted.trackName, exportEvent.trackName);
    assert.equal(inserted.artistName, exportEvent.artistName);
    assert.equal(inserted.albumName, exportEvent.albumName);
    assert.equal(inserted.playedAt.toISOString(), exportEvent.estimatedStartedAt.toISOString());

    const metadata = asRecord(inserted.metadata);
    const extended = asRecord(metadata.spotifyExtendedHistory);
    assert.equal(extended.spotifyTrackUri, null);
    assert.equal(extended.sourceEventKey, exportEvent.sourceEventKey);

    const second = await applySpotifyExtendedHistory({
      userId: user.id,
      packageSha256: PACKAGE_SHA,
      expectedPackageSha256: PACKAGE_SHA,
      expectedPlanHash: plan.planHash,
      expectedManifestHash: manifest.manifestHash,
      manifest,
      musicEvents: [exportEvent],
      client: prisma,
    });

    assert.equal(second.insertedEvents, 0);
    assert.equal(second.duplicateEvents, 1);
    assert.equal(
      await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
      1,
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("HISTORY-02 stale URI-less insert is guarded by an exact Last.fm candidate", async () => {
  const user = await prisma.user.create({
    data: { email: `history02-no-uri-guard-${randomUUID()}@example.test` },
  });

  try {
    const exportEvent = noUriEvent(
      "guard",
      "Guard Artist",
      "Guard Track",
      "Guard Album",
      new Date("2026-08-18T12:00:00Z"),
    );

    const reconciliation = reconcileSpotifyExtendedHistory([exportEvent], []);
    const plan = buildSpotifyExtendedPersistencePlan(PACKAGE_SHA, reconciliation);
    const manifest = buildSpotifyExtendedPersistenceManifest(user.id, plan);
    assert.equal(plan.summary.insertNew, 1);

    // Simulate drift after the frozen dry-run: Last.fm writes the same factual
    // play before HISTORY-02 reaches the writer. URI-less inserts must converge
    // to a guarded no-op through exact normalized artist+track + time.
    await prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        spotifyTrackId: null,
        spotifyUri: null,
        trackName: "  guard   track ",
        artistName: "GUARD ARTIST",
        albumName: null,
        playedAt: new Date(exportEvent.estimatedStartedAt.getTime() + 30_000),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: "lastfm-uri-less-guard",
      },
    });

    const result = await applySpotifyExtendedHistory({
      userId: user.id,
      packageSha256: PACKAGE_SHA,
      expectedPackageSha256: PACKAGE_SHA,
      expectedPlanHash: plan.planHash,
      expectedManifestHash: manifest.manifestHash,
      manifest,
      musicEvents: [exportEvent],
      client: prisma,
    });

    assert.equal(result.insertedEvents, 0);
    assert.equal(result.duplicateEvents, 1);
    assert.equal(
      await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
      1,
      "stale URI-less INSERT_NEW must not duplicate the Last.fm play",
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

function noUriEvent(
  id: string,
  artistName: string,
  trackName: string,
  albumName: string,
  estimatedStartedAt: Date,
): SpotifyExtendedMusicEvent {
  const msPlayed = 180_000;
  return {
    sourceFile: "fixture.json",
    sourceIndex: 0,
    endedAt: new Date(estimatedStartedAt.getTime() + msPlayed),
    estimatedStartedAt,
    msPlayed,
    spotifyTrackUri: null,
    spotifyTrackId: null,
    trackName,
    artistName,
    albumName,
    reasonStart: "trackdone",
    reasonEnd: "trackdone",
    skipped: false,
    offline: false,
    offlineTimestamp: null,
    incognitoMode: false,
    sourceEventKey: `extended-no-uri-${id}`,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.ok(!Array.isArray(value));
  return value as Record<string, unknown>;
}
