import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const PROVIDER = "spotify";

export type SpotifyBackoffReason = "QUOTA_EXCEEDED" | "RATE_LIMITED";

export type SpotifyBackoffState = {
  provider: "spotify";
  reason: SpotifyBackoffReason;
  operation: string | null;
  retryAfterSeconds: number | null;
  blockedUntil: Date;
  observedAt: Date;
  updatedAt: Date;
};

export class SpotifyBackoffActiveError extends Error {
  readonly code = "SPOTIFY_BACKOFF_ACTIVE";
  readonly reason: SpotifyBackoffReason;
  readonly operation: string | null;
  readonly blockedUntil: Date;
  readonly retryAfterSecondsRemaining: number;

  constructor(state: SpotifyBackoffState, now = new Date()) {
    const remaining = retryAfterSecondsRemaining(state, now);
    super(
      `Spotify temporariamente bloqueado por ${state.reason} até ${state.blockedUntil.toISOString()} (${remaining}s restantes).`,
    );
    this.name = "SpotifyBackoffActiveError";
    this.reason = state.reason;
    this.operation = state.operation;
    this.blockedUntil = state.blockedUntil;
    this.retryAfterSecondsRemaining = remaining;
  }
}

type ProviderBackoffRow = {
  provider: string;
  reason: string;
  operation: string | null;
  retryAfterSeconds: number | null;
  blockedUntil: Date;
  observedAt: Date;
  updatedAt: Date;
};

export async function getActiveSpotifyBackoff(
  now = new Date(),
): Promise<SpotifyBackoffState | null> {
  const rows = await prisma.$queryRaw<ProviderBackoffRow[]>(Prisma.sql`
    SELECT
      "provider",
      "reason",
      "operation",
      "retryAfterSeconds",
      "blockedUntil",
      "observedAt",
      "updatedAt"
    FROM "ProviderBackoff"
    WHERE "provider" = ${PROVIDER}
      AND "blockedUntil" > ${now}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;
  if (row.reason !== "QUOTA_EXCEEDED" && row.reason !== "RATE_LIMITED") {
    return null;
  }

  return {
    provider: "spotify",
    reason: row.reason,
    operation: row.operation,
    retryAfterSeconds: row.retryAfterSeconds,
    blockedUntil: row.blockedUntil,
    observedAt: row.observedAt,
    updatedAt: row.updatedAt,
  };
}

export async function assertSpotifyBackoffInactive(
  now = new Date(),
): Promise<void> {
  const state = await getActiveSpotifyBackoff(now);
  if (state) throw new SpotifyBackoffActiveError(state, now);
}

export async function recordSpotifyBackoff(input: {
  reason: SpotifyBackoffReason;
  operation?: string | null;
  retryAfterSeconds: number | null;
  observedAt?: Date;
}): Promise<SpotifyBackoffState | null> {
  const retryAfterSeconds = normalizeRetryAfter(input.retryAfterSeconds);
  if (retryAfterSeconds === null) return null;

  const observedAt = input.observedAt ?? new Date();
  const blockedUntil = new Date(observedAt.getTime() + retryAfterSeconds * 1000);

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "ProviderBackoff" (
      "provider",
      "reason",
      "operation",
      "retryAfterSeconds",
      "blockedUntil",
      "observedAt",
      "updatedAt"
    )
    VALUES (
      ${PROVIDER},
      ${input.reason},
      ${input.operation ?? null},
      ${retryAfterSeconds},
      ${blockedUntil},
      ${observedAt},
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("provider") DO UPDATE
    SET
      "reason" = CASE
        WHEN EXCLUDED."blockedUntil" >= "ProviderBackoff"."blockedUntil"
          THEN EXCLUDED."reason"
        ELSE "ProviderBackoff"."reason"
      END,
      "operation" = CASE
        WHEN EXCLUDED."blockedUntil" >= "ProviderBackoff"."blockedUntil"
          THEN EXCLUDED."operation"
        ELSE "ProviderBackoff"."operation"
      END,
      "retryAfterSeconds" = CASE
        WHEN EXCLUDED."blockedUntil" >= "ProviderBackoff"."blockedUntil"
          THEN EXCLUDED."retryAfterSeconds"
        ELSE "ProviderBackoff"."retryAfterSeconds"
      END,
      "observedAt" = CASE
        WHEN EXCLUDED."blockedUntil" >= "ProviderBackoff"."blockedUntil"
          THEN EXCLUDED."observedAt"
        ELSE "ProviderBackoff"."observedAt"
      END,
      "blockedUntil" = GREATEST(
        "ProviderBackoff"."blockedUntil",
        EXCLUDED."blockedUntil"
      ),
      "updatedAt" = CURRENT_TIMESTAMP
  `);

  return getActiveSpotifyBackoff(observedAt);
}

export function retryAfterSecondsRemaining(
  state: Pick<SpotifyBackoffState, "blockedUntil">,
  now = new Date(),
): number {
  return Math.max(0, Math.ceil((state.blockedUntil.getTime() - now.getTime()) / 1000));
}

export function spotifyBackoffApiPayload(
  state: SpotifyBackoffState,
  now = new Date(),
) {
  return {
    code: "SPOTIFY_BACKOFF_ACTIVE" as const,
    reason: state.reason,
    operation: state.operation,
    blockedUntil: state.blockedUntil.toISOString(),
    retryAfterSecondsRemaining: retryAfterSecondsRemaining(state, now),
  };
}

function normalizeRetryAfter(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.ceil(value));
}
