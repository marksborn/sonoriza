import {
  MusicIngestionRunStatus,
  MusicIngestionTrigger,
  Prisma,
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  runManualMusicIngestion,
  syncMusicIngestionRule,
  type ManualMusicIngestionInput,
  type MusicIngestionSyncResult,
  type SyncMusicIngestionOptions,
} from "@/services/spotify/music-ingestion";

const LEASE_MS = 10 * 60 * 1000;

export class MusicIngestionBusyError extends Error {
  constructor() {
    super("Já existe uma alimentação em andamento para esta inbox. Tente novamente após a execução atual terminar.");
    this.name = "MusicIngestionBusyError";
  }
}

export class MusicIngestionPreviewRequiredError extends Error {
  constructor() {
    super("Gere e revise o preview da importação atual antes de confirmar a primeira escrita.");
    this.name = "MusicIngestionPreviewRequiredError";
  }
}

export async function syncMusicIngestionRuleSerialized(
  userId: string,
  ruleId: string,
  options: SyncMusicIngestionOptions = {},
): Promise<MusicIngestionSyncResult> {
  const rule = await prisma.musicIngestionRule.findFirst({
    where: { id: ruleId, userId },
    select: {
      id: true,
      targetSourcePlaylistId: true,
      createdAt: true,
    },
  });
  if (!rule) throw new Error("Regra de alimentação não encontrada.");

  if (options.preview === true) {
    return syncMusicIngestionRule(userId, ruleId, options);
  }

  if (options.allowInitialImport === true) {
    const preview = await prisma.musicIngestionRun.findFirst({
      where: {
        userId,
        ruleId: rule.id,
        targetSourcePlaylistId: rule.targetSourcePlaylistId,
        preview: true,
        status: MusicIngestionRunStatus.PREVIEW,
        trigger: MusicIngestionTrigger.INITIAL_IMPORT,
        startedAt: { gte: rule.createdAt },
      },
      select: { id: true },
      orderBy: { startedAt: "desc" },
    });
    if (!preview) throw new MusicIngestionPreviewRequiredError();
  }

  return withTargetIngestionLease(userId, rule.targetSourcePlaylistId, () =>
    syncMusicIngestionRule(userId, ruleId, options),
  );
}

export async function runManualMusicIngestionSerialized(
  userId: string,
  input: ManualMusicIngestionInput,
): Promise<MusicIngestionSyncResult> {
  if (input.preview === true) {
    return runManualMusicIngestion(userId, input);
  }

  return withTargetIngestionLease(userId, input.targetSourcePlaylistId, () =>
    runManualMusicIngestion(userId, input),
  );
}

async function withTargetIngestionLease<T>(
  userId: string,
  targetSourcePlaylistId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + LEASE_MS);

  const rows = await prisma.$queryRaw<Array<{ token: string }>>(Prisma.sql`
    INSERT INTO "MusicIngestionLease" (
      "targetSourcePlaylistId",
      "token",
      "expiresAt",
      "updatedAt"
    )
    SELECT
      "id",
      ${token},
      ${expiresAt},
      CURRENT_TIMESTAMP
    FROM "SourcePlaylist"
    WHERE "id" = ${targetSourcePlaylistId}
      AND "userId" = ${userId}
    ON CONFLICT ("targetSourcePlaylistId") DO UPDATE
    SET
      "token" = EXCLUDED."token",
      "expiresAt" = EXCLUDED."expiresAt",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "MusicIngestionLease"."expiresAt" < CURRENT_TIMESTAMP
    RETURNING "token"
  `);

  if (rows.length !== 1 || rows[0]?.token !== token) {
    throw new MusicIngestionBusyError();
  }

  try {
    return await operation();
  } finally {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "MusicIngestionLease"
      WHERE "targetSourcePlaylistId" = ${targetSourcePlaylistId}
        AND "token" = ${token}
    `);
  }
}
