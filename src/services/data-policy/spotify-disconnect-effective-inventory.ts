import { Prisma, type PrismaClient } from "@prisma/client";

import type { SpotifyDisconnectInventory } from "./spotify-disconnect-preview";
import { PrismaSpotifyDisconnectInventoryStore } from "./spotify-disconnect-prisma-inventory";

type QueryClient = Pick<PrismaClient, "$queryRaw">;

/**
 * Gate 6A deliberately counted any non-null GenerationRun.summary as a row
 * requiring selective inspection/redaction. Gate 6B knows one subtree is safe
 * to retain: `music06PlannerInfluence` (Last.fm + Sonoriza first-party).
 *
 * This adapter subtracts already-clean, safe-only summaries so prepare/postcheck
 * are idempotent without weakening the conservative Gate 6A inventory.
 */
export async function loadSpotifyDisconnectExecutionInventory(
  client: QueryClient,
  userId: string,
): Promise<SpotifyDisconnectInventory> {
  const base = await new PrismaSpotifyDisconnectInventoryStore(
    client as unknown as PrismaClient,
  ).load(userId);

  const rows = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS "count"
    FROM "GenerationRun"
    WHERE "userId" = ${userId}
      AND "error" IS NULL
      AND "summary" IS NOT NULL
      AND jsonb_typeof("summary") = 'object'
      AND "summary" ? 'music06PlannerInfluence'
      AND CASE
        WHEN jsonb_typeof("summary") = 'object'
          THEN ("summary" - 'music06PlannerInfluence') = '{}'::jsonb
        ELSE false
      END
  `);

  const safeOnlySummaryCount = Number(rows[0]?.count ?? 0n);
  if (!Number.isSafeInteger(safeOnlySummaryCount) || safeOnlySummaryCount < 0) {
    throw new Error("Spotify disconnect safe generation summary count is invalid");
  }

  const generationAuditWithProviderFields =
    base.generationAuditWithProviderFields - safeOnlySummaryCount;

  if (generationAuditWithProviderFields < 0) {
    throw new Error(
      "Spotify disconnect generation audit normalization became negative",
    );
  }

  return {
    ...base,
    generationAuditWithProviderFields,
  };
}
