import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

import type { SpotifyExtendedMusicEvent } from "./parser";
import { buildSpotifyExtendedPersistenceManifest } from "./persistence-manifest";
import { buildSpotifyExtendedPersistencePlan } from "./persistence-plan";
import {
  applySpotifyExtendedHistory,
  markSpotifyExtendedHistoryRunPartial,
} from "./persistence-writer";
import { reconcileSpotifyExtendedHistory } from "./reconcile";

const PACKAGE_SHA = "c".repeat(64);

function clientInSaoPaulo(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must be set for HISTORY-02 integration tests");

  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-c TimeZone=America/Sao_Paulo");

  return new PrismaClient({
    datasources: {
      db: { url: url.toString() },
    },
  });
}

function event(id: string, estimatedStartedAt: string): SpotifyExtendedMusicEvent {
  const startedAt = new Date(estimatedStartedAt);
  const msPlayed = 180_000;

  return {
    sourceFile: "fixture.json",
    sourceIndex: 0,
    endedAt: new Date(startedAt.getTime() + msPlayed),
    estimatedStartedAt: startedAt,
    msPlayed,
    spotifyTrackUri: `spotify:track:${id}`,
    spotifyTrackId: id,
    trackName: `Track ${id}`,
    artistName: `Artist ${id}`,
    albumName: `Album ${id}`,
    reasonStart: "trackdone",
    reasonEnd: "trackdone",
    skipped: false,
    offline: false,
    offlineTimestamp: null,
    incognitoMode: false,
    sourceEventKey: `extended-${id}`,
  };
}

test("HISTORY-02 writer stores UTC playedAt even when PostgreSQL session uses America/Sao_Paulo", async () => {
  const client = clientInSaoPaulo();
  const user = await client.user.create({
    data: { email: `history02-timezone-${randomUUID()}@example.test` },
  });

  try {
    const timezone = await client.$queryRaw<Array<{ timezone: string }>>(Prisma.sql`
      SELECT current_setting('TimeZone') AS "timezone"
    `);
    assert.equal(timezone[0]?.timezone, "America/Sao_Paulo");

    const exportEvents = [
      event("standard", "2026-08-18T10:00:00.000Z"),
      event("dst", "2017-01-15T10:00:00.000Z"),
    ];

    const reconciliation = reconcileSpotifyExtendedHistory(exportEvents, []);
    const plan = buildSpotifyExtendedPersistencePlan(PACKAGE_SHA, reconciliation);
    const manifest = buildSpotifyExtendedPersistenceManifest(user.id, plan);

    const result = await applySpotifyExtendedHistory({
      userId: user.id,
      packageSha256: PACKAGE_SHA,
      expectedPackageSha256: PACKAGE_SHA,
      expectedPlanHash: plan.planHash,
      expectedManifestHash: manifest.manifestHash,
      manifest,
      musicEvents: exportEvents,
      client,
      batchSize: 2,
    });

    assert.equal(result.insertedEvents, 2);
    assert.equal(result.duplicateEvents, 0);

    const rows = await client.$queryRaw<
      Array<{
        sourceEventKey: string;
        playedAt: Date;
        metadata: unknown;
      }>
    >(Prisma.sql`
      SELECT "sourceEventKey", "playedAt", "metadata"
      FROM "TrackListeningEvent"
      WHERE "userId" = ${user.id}
        AND "source" = 'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource"
      ORDER BY "sourceEventKey"
    `);

    assert.equal(rows.length, 2);

    for (const source of exportEvents) {
      const row = rows.find((candidate) => candidate.sourceEventKey === source.sourceEventKey);
      assert.ok(row);
      assert.equal(
        row.playedAt.getTime(),
        source.estimatedStartedAt.getTime(),
        `${source.sourceEventKey} must preserve the UTC instant`,
      );

      const metadata = row.metadata as {
        spotifyExtendedHistory?: { estimatedStartedAt?: string };
      };
      assert.equal(
        metadata.spotifyExtendedHistory?.estimatedStartedAt,
        source.estimatedStartedAt.toISOString(),
      );
    }

    await markSpotifyExtendedHistoryRunPartial(
      client,
      result.runId,
      "postcheck regression fixture",
    );

    const audit = await client.$queryRaw<
      Array<{ status: string; error: string | null }>
    >(Prisma.sql`
      SELECT "status"::text AS "status", "error"
      FROM "SpotifyExtendedHistoryImportRun"
      WHERE "id" = ${result.runId}
    `);

    assert.equal(audit[0]?.status, "PARTIAL");
    assert.equal(audit[0]?.error, "postcheck regression fixture");
  } finally {
    await client.user.delete({ where: { id: user.id } });
    await client.$disconnect();
  }
});
