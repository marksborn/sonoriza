import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { retryAfterSecondsRemaining } from "./backoff";

const migrationTest =
  process.env.SPOTIFY_BACKOFF_MIGRATION_TEST === "1" ? test : test.skip;

migrationTest(
  "legacy America/Sao_Paulo ProviderBackoff wall-clock values migrate to the same absolute instants",
  async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        provider: string;
        retryAfterSeconds: number | null;
        blockedUntil: Date;
        observedAt: Date;
        updatedAt: Date;
      }>
    >(`
      SELECT
        "provider",
        "retryAfterSeconds",
        "blockedUntil",
        "observedAt",
        "updatedAt"
      FROM "ProviderBackoff"
      WHERE "provider" = 'spotify'
      LIMIT 1
    `);

    const row = rows[0];
    assert.ok(row, "expected the workflow to seed the legacy ProviderBackoff row");
    assert.equal(row.retryAfterSeconds, 73817);
    assert.equal(row.observedAt.toISOString(), "2026-09-20T15:37:32.022Z");
    assert.equal(row.blockedUntil.toISOString(), "2026-09-21T12:07:49.022Z");
    assert.equal(row.updatedAt.toISOString(), "2026-09-20T15:37:32.024Z");

    assert.equal(
      retryAfterSecondsRemaining(
        { blockedUntil: row.blockedUntil },
        new Date("2026-09-20T15:44:34.336Z"),
      ),
      73395,
    );
  },
);
