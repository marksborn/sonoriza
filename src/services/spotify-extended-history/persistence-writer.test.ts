import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import type { SpotifyExtendedMusicEvent } from "./parser";
import { buildSpotifyExtendedPersistenceManifest } from "./persistence-manifest";
import { buildSpotifyExtendedPersistencePlan } from "./persistence-plan";
import { applySpotifyExtendedHistory } from "./persistence-writer";
import {
  reconcileSpotifyExtendedHistory,
  type ExistingListeningEvent,
} from "./reconcile";

const PACKAGE_SHA = "a".repeat(64);

test("HISTORY-02 writer inserts, enriches, quarantines and is idempotent", async () => {
  const user = await prisma.user.create({
    data: { email: `history02-writer-${randomUUID()}@example.test` },
  });

  try {
    const exactAt = new Date("2026-08-18T10:00:00Z");
    const conflictAt = new Date("2026-08-18T12:00:00Z");

    const exactExisting = await prisma.trackListeningEvent.create({
      data: {
        userId: user.id,
        spotifyTrackId: null,
        spotifyUri: null,
        trackName: "Exact Track",
        artistName: "Exact Artist",
        albumName: null,
        playedAt: exactAt,
        source: "LASTFM_SCROBBLE",
        sourceEventKey: "lastfm-exact",
        metadata: { lastFmUrl: "https://example.test/lastfm-exact" },
      },
    });

    await prisma.trackListeningEvent.createMany({
      data: [
        {
          userId: user.id,
          trackName: "Conflict Track",
          artistName: "Conflict Artist",
          playedAt: new Date(conflictAt.getTime() + 20_000),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: "lastfm-conflict-1",
        },
        {
          userId: user.id,
          trackName: "Conflict Track",
          artistName: "Conflict Artist",
          playedAt: new Date(conflictAt.getTime() + 40_000),
          source: "LASTFM_SCROBBLE",
          sourceEventKey: "lastfm-conflict-2",
        },
      ],
    });

    const exportEvents = [
      event("exact", "Exact Artist", "Exact Track", "Exact Album", exactAt),
      event("new", "New Artist", "New Track", "New Album", new Date("2026-08-18T11:00:00Z")),
      event("conflict", "Conflict Artist", "Conflict Track", "Conflict Album", conflictAt),
    ];

    const existingRows = await prisma.trackListeningEvent.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        spotifyTrackId: true,
        trackName: true,
        artistName: true,
        playedAt: true,
        source: true,
        metadata: true,
      },
    });

    const reconciliation = reconcileSpotifyExtendedHistory(
      exportEvents,
      existingRows as ExistingListeningEvent[],
    );
    assert.deepEqual(
      reconciliation.entries.map((entry) => entry.classification),
      ["EXACT_EXISTING_LASTFM", "NEW_UNCOVERED_EVENT", "CONFLICT_AMBIGUOUS"],
    );

    const plan = buildSpotifyExtendedPersistencePlan(PACKAGE_SHA, reconciliation);
    const manifest = buildSpotifyExtendedPersistenceManifest(user.id, plan);
    assert.deepEqual(plan.summary, {
      insertNew: 1,
      enrichExisting: 1,
      quarantineConflict: 1,
      noopAlreadyEnriched: 0,
    });

    const first = await applySpotifyExtendedHistory({
      userId: user.id,
      packageSha256: PACKAGE_SHA,
      expectedPackageSha256: PACKAGE_SHA,
      expectedPlanHash: plan.planHash,
      expectedManifestHash: manifest.manifestHash,
      manifest,
      musicEvents: exportEvents,
      client: prisma,
      batchSize: 2,
    });

    assert.equal(first.insertedEvents, 1);
    assert.equal(first.enrichedEvents, 1);
    assert.equal(first.duplicateEvents, 0);
    assert.equal(first.noopEvents, 0);
    assert.equal(first.quarantinedEvents, 1);
    assert.equal(first.manifestHash, manifest.manifestHash);

    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        source: string;
        sourceEventKey: string;
        spotifyTrackId: string | null;
        spotifyUri: string | null;
        albumName: string | null;
        metadata: unknown;
      }>
    >(Prisma.sql`
      SELECT
        "id",
        "source"::text AS "source",
        "sourceEventKey",
        "spotifyTrackId",
        "spotifyUri",
        "albumName",
        "metadata"
      FROM "TrackListeningEvent"
      WHERE "userId" = ${user.id}
      ORDER BY "playedAt", "sourceEventKey"
    `);

    assert.equal(rows.length, 4, "conflict must not create a fifth listening event");

    const inserted = rows.find((row) => row.sourceEventKey === exportEvents[1]!.sourceEventKey);
    assert.ok(inserted);
    assert.equal(inserted.source, "SPOTIFY_EXTENDED_HISTORY");
    assert.equal(inserted.spotifyTrackId, exportEvents[1]!.spotifyTrackId);
    assert.equal(inserted.spotifyUri, exportEvents[1]!.spotifyTrackUri);
    assert.equal(inserted.albumName, "New Album");
    assertExtendedMetadata(inserted.metadata, exportEvents[1]!);

    const enriched = rows.find((row) => row.id === exactExisting.id);
    assert.ok(enriched);
    assert.equal(enriched.source, "LASTFM_SCROBBLE", "canonical source must be preserved");
    assert.equal(enriched.spotifyTrackId, exportEvents[0]!.spotifyTrackId);
    assert.equal(enriched.spotifyUri, exportEvents[0]!.spotifyTrackUri);
    assert.equal(enriched.albumName, "Exact Album");
    const enrichedMetadata = asRecord(enriched.metadata);
    assert.equal(enrichedMetadata.lastFmUrl, "https://example.test/lastfm-exact");
    assertExtendedMetadata(enriched.metadata, exportEvents[0]!);

    assert.equal(
      await prisma.trackListeningState.count({ where: { userId: user.id } }),
      0,
      "historical import must never mutate MUSIC-01 cooldown state",
    );

    const second = await applySpotifyExtendedHistory({
      userId: user.id,
      packageSha256: PACKAGE_SHA,
      expectedPackageSha256: PACKAGE_SHA,
      expectedPlanHash: plan.planHash,
      expectedManifestHash: manifest.manifestHash,
      manifest,
      musicEvents: exportEvents,
      client: prisma,
      batchSize: 2,
    });

    assert.equal(second.insertedEvents, 0, "same frozen manifest must never duplicate new events");
    assert.equal(second.enrichedEvents, 0, "same frozen manifest must never overwrite enrichment");
    assert.equal(second.duplicateEvents, 1);
    assert.equal(second.noopEvents, 1);
    assert.equal(second.quarantinedEvents, 1);

    assert.equal(
      await prisma.trackListeningEvent.count({ where: { userId: user.id } }),
      4,
      "second execution must leave listening event count unchanged",
    );

    const auditRuns = await prisma.$queryRaw<Array<{ status: string; insertedEvents: number; enrichedEvents: number }>>(
      Prisma.sql`
        SELECT "status"::text AS "status", "insertedEvents", "enrichedEvents"
        FROM "SpotifyExtendedHistoryImportRun"
        WHERE "userId" = ${user.id}
        ORDER BY "startedAt", "id"
      `,
    );
    assert.equal(auditRuns.length, 2);
    assert.deepEqual(auditRuns.map((run) => run.status), ["SUCCESS", "SUCCESS"]);
    assert.deepEqual(auditRuns.map((run) => run.insertedEvents), [1, 0]);
    assert.deepEqual(auditRuns.map((run) => run.enrichedEvents), [1, 0]);

    await assert.rejects(
      applySpotifyExtendedHistory({
        userId: user.id,
        packageSha256: PACKAGE_SHA,
        expectedPackageSha256: PACKAGE_SHA,
        expectedPlanHash: "0".repeat(64),
        expectedManifestHash: manifest.manifestHash,
        manifest,
        musicEvents: exportEvents,
        client: prisma,
      }),
      /plan hash does not match/i,
    );

    const auditAfterRejectedPlan = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "SpotifyExtendedHistoryImportRun"
        WHERE "userId" = ${user.id}
      `,
    );
    assert.equal(Number(auditAfterRejectedPlan[0]?.count ?? -1), 2, "hash drift must abort before audit/write");

    await assert.rejects(
      applySpotifyExtendedHistory({
        userId: user.id,
        packageSha256: PACKAGE_SHA,
        expectedPackageSha256: "b".repeat(64),
        expectedPlanHash: plan.planHash,
        expectedManifestHash: manifest.manifestHash,
        manifest,
        musicEvents: exportEvents,
        client: prisma,
      }),
      /package SHA does not match/i,
    );

    await assert.rejects(
      applySpotifyExtendedHistory({
        userId: `${user.id}-other`,
        packageSha256: PACKAGE_SHA,
        expectedPackageSha256: PACKAGE_SHA,
        expectedPlanHash: plan.planHash,
        expectedManifestHash: manifest.manifestHash,
        manifest,
        musicEvents: exportEvents,
        client: prisma,
      }),
      /manifest user does not match/i,
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

function event(
  id: string,
  artistName: string,
  trackName: string,
  albumName: string,
  estimatedStartedAt: Date,
): SpotifyExtendedMusicEvent {
  const msPlayed = id === "conflict" ? 90_000 : 180_000;
  return {
    sourceFile: "fixture.json",
    sourceIndex: 0,
    endedAt: new Date(estimatedStartedAt.getTime() + msPlayed),
    estimatedStartedAt,
    msPlayed,
    spotifyTrackUri: `spotify:track:${id}`,
    spotifyTrackId: id,
    trackName,
    artistName,
    albumName,
    reasonStart: "trackdone",
    reasonEnd: id === "new" ? "fwdbtn" : "trackdone",
    skipped: id === "new",
    offline: true,
    offlineTimestamp: 123456,
    incognitoMode: true,
    sourceEventKey: `extended-${id}`,
  };
}

function assertExtendedMetadata(metadata: unknown, event: SpotifyExtendedMusicEvent): void {
  const outer = asRecord(metadata);
  const extended = asRecord(outer.spotifyExtendedHistory);
  assert.equal(extended.packageSha256, PACKAGE_SHA);
  assert.equal(extended.sourceEventKey, event.sourceEventKey);
  assert.equal(extended.spotifyTrackUri, event.spotifyTrackUri);
  assert.equal(extended.msPlayed, event.msPlayed);
  assert.equal(extended.skipped, event.skipped);
  assert.equal(extended.explicitSkip, event.skipped === true);
  assert.equal(extended.reasonStart, event.reasonStart);
  assert.equal(extended.reasonEnd, event.reasonEnd);
  assert.ok(!("offline" in extended), "offline telemetry is intentionally not persisted in v1");
  assert.ok(!("offlineTimestamp" in extended), "offline timestamp is intentionally not persisted in v1");
  assert.ok(!("incognitoMode" in extended), "incognito flag is intentionally not persisted in v1");
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.ok(!Array.isArray(value));
  return value as Record<string, unknown>;
}
