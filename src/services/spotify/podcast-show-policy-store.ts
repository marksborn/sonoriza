import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type PodcastEpisodeEligibilityValue =
  | "UNPLAYED_ONLY"
  | "PLAYED_ONLY"
  | "ALL";
export type PodcastShowOrderValue =
  | "OLDEST_FIRST"
  | "NEWEST_FIRST"
  | "RANDOM";
export type PodcastRandomPolicyValue =
  | "WITHOUT_REPLACEMENT"
  | "WITH_REPLACEMENT";
export type PodcastExpiryPolicyValue =
  | "STRICT_EXPIRY"
  | "ALLOW_IN_PROGRESS_TO_FINISH";

export type PodcastShowPolicySnapshot = {
  sourcePlaylistId: string;
  episodeEligibility: PodcastEpisodeEligibilityValue;
  episodeOrder: PodcastShowOrderValue;
  randomPolicy: PodcastRandomPolicyValue;
  startEpisodeId: string | null;
  strictSequence: boolean;
  maxReleaseAgeDays: number | null;
  expiryPolicy: PodcastExpiryPolicyValue;
  maxEpisodesPerCycle: number | null;
  sequenceCursorEpisodeId: string | null;
  sequenceCompleted: boolean;
  randomRound: number;
  randomConsumedEpisodeIds: string[];
};

export type PodcastShowPolicyUpdate = Pick<
  PodcastShowPolicySnapshot,
  | "episodeEligibility"
  | "episodeOrder"
  | "randomPolicy"
  | "startEpisodeId"
  | "strictSequence"
  | "maxReleaseAgeDays"
  | "expiryPolicy"
  | "maxEpisodesPerCycle"
>;

export type PodcastShowPolicySelection = {
  sourcePlaylistId: string;
  spotifyEpisodeId: string;
  episodeOrder: PodcastShowOrderValue;
  randomPolicy: PodcastRandomPolicyValue;
  randomRound: number;
  randomRoundReset: boolean;
  sequenceStateful: boolean;
  sequenceIndex: number | null;
  nextSequenceEpisodeId: string | null;
};

type PolicyRow = {
  sourcePlaylistId: string;
  includePlayed: boolean;
  legacyEpisodeOrder: string;
  episodeEligibility: string | null;
  episodeOrder: string | null;
  randomPolicy: string | null;
  startEpisodeId: string | null;
  strictSequence: boolean | null;
  maxReleaseAgeDays: number | null;
  expiryPolicy: string | null;
  maxEpisodesPerCycle: number | null;
  sequenceCursorEpisodeId: string | null;
  sequenceCompleted: boolean | null;
  randomRound: number | null;
  randomConsumedEpisodeIds: unknown;
};

/**
 * PODCAST-05 uses a raw-SQL companion table on purpose in this gate. This keeps
 * the policy/state independent from SourcePlaylist's provider/cache concerns and
 * from EpisodeListeningState's canonical Spotify playback facts.
 */
export async function loadPodcastShowPolicies(
  userId: string,
): Promise<Map<string, PodcastShowPolicySnapshot>> {
  const rows = await prisma.$queryRaw<PolicyRow[]>`
    SELECT
      s."id" AS "sourcePlaylistId",
      s."includePlayed" AS "includePlayed",
      s."episodeOrder"::text AS "legacyEpisodeOrder",
      p."episodeEligibility",
      p."episodeOrder",
      p."randomPolicy",
      p."startEpisodeId",
      p."strictSequence",
      p."maxReleaseAgeDays",
      p."expiryPolicy",
      p."maxEpisodesPerCycle",
      p."sequenceCursorEpisodeId",
      p."sequenceCompleted",
      p."randomRound",
      p."randomConsumedEpisodeIds"
    FROM "SourcePlaylist" s
    LEFT JOIN "PodcastShowPolicy" p
      ON p."sourcePlaylistId" = s."id"
    WHERE s."userId" = ${userId}
      AND s."kind"::text = 'PODCAST'
      AND s."spotifyType"::text = 'SHOW'
  `;

  return new Map(
    rows.map((row) => {
      const policy = normalizePolicyRow(row);
      return [policy.sourcePlaylistId, policy] as const;
    }),
  );
}

export async function savePodcastShowPolicy(
  userId: string,
  sourcePlaylistId: string,
  input: PodcastShowPolicyUpdate,
): Promise<boolean> {
  const maxReleaseAgeDays = normalizeNullableNonNegativeInt(input.maxReleaseAgeDays);
  const maxEpisodesPerCycle = normalizeNullablePositiveInt(input.maxEpisodesPerCycle);
  const startEpisodeId = normalizedId(input.startEpisodeId);

  const rows = await prisma.$queryRaw<Array<{ sourcePlaylistId: string }>>`
    INSERT INTO "PodcastShowPolicy" (
      "sourcePlaylistId",
      "episodeEligibility",
      "episodeOrder",
      "randomPolicy",
      "startEpisodeId",
      "strictSequence",
      "maxReleaseAgeDays",
      "expiryPolicy",
      "maxEpisodesPerCycle",
      "sequenceCursorEpisodeId",
      "sequenceCompleted",
      "randomRound",
      "randomConsumedEpisodeIds",
      "updatedAt"
    )
    SELECT
      s."id",
      ${input.episodeEligibility},
      ${input.episodeOrder},
      ${input.randomPolicy},
      ${startEpisodeId},
      ${input.strictSequence},
      ${maxReleaseAgeDays},
      ${input.expiryPolicy},
      ${maxEpisodesPerCycle},
      NULL,
      false,
      0,
      '[]'::jsonb,
      CURRENT_TIMESTAMP
    FROM "SourcePlaylist" s
    WHERE s."id" = ${sourcePlaylistId}
      AND s."userId" = ${userId}
      AND s."kind"::text = 'PODCAST'
      AND s."spotifyType"::text = 'SHOW'
    ON CONFLICT ("sourcePlaylistId") DO UPDATE SET
      "episodeEligibility" = EXCLUDED."episodeEligibility",
      "episodeOrder" = EXCLUDED."episodeOrder",
      "randomPolicy" = EXCLUDED."randomPolicy",
      "startEpisodeId" = EXCLUDED."startEpisodeId",
      "strictSequence" = EXCLUDED."strictSequence",
      "maxReleaseAgeDays" = EXCLUDED."maxReleaseAgeDays",
      "expiryPolicy" = EXCLUDED."expiryPolicy",
      "maxEpisodesPerCycle" = EXCLUDED."maxEpisodesPerCycle",
      -- A changed policy starts a deliberate new traversal/shuffle.
      "sequenceCursorEpisodeId" = NULL,
      "sequenceCompleted" = false,
      "randomRound" = 0,
      "randomConsumedEpisodeIds" = '[]'::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "sourcePlaylistId"
  `;

  if (rows.length !== 1) return false;

  // Keep the legacy flags coherent for code paths that still consume them.
  await prisma.sourcePlaylist.updateMany({
    where: { id: sourcePlaylistId, userId },
    data: {
      includePlayed: input.episodeEligibility !== "UNPLAYED_ONLY",
      episodeOrder:
        input.episodeOrder === "NEWEST_FIRST"
          ? "NEWEST_FIRST"
          : input.episodeOrder === "OLDEST_FIRST"
            ? "OLDEST_FIRST"
            : "SOURCE_DEFAULT",
    },
  });
  return true;
}

export async function resetPodcastShowPolicyProgress(
  userId: string,
  sourcePlaylistId: string,
): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "PodcastShowPolicy" p
    SET
      "sequenceCursorEpisodeId" = NULL,
      "sequenceCompleted" = false,
      "randomRound" = "randomRound" + 1,
      "randomConsumedEpisodeIds" = '[]'::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM "SourcePlaylist" s
    WHERE p."sourcePlaylistId" = s."id"
      AND s."id" = ${sourcePlaylistId}
      AND s."userId" = ${userId}
      AND s."spotifyType"::text = 'SHOW'
  `;
  return changed === 1;
}

/**
 * Commit Sonoriza-owned traversal state only after a real target write and its
 * GenerationItem audit rows succeeded. Simulations never call this function.
 */
export async function recordPodcastShowPolicySelections(
  selections: PodcastShowPolicySelection[],
): Promise<void> {
  if (selections.length === 0) return;

  const grouped = new Map<string, PodcastShowPolicySelection[]>();
  for (const selection of selections) {
    const bucket = grouped.get(selection.sourcePlaylistId) ?? [];
    bucket.push(selection);
    grouped.set(selection.sourcePlaylistId, bucket);
  }

  await prisma.$transaction(async (tx) => {
    for (const [sourcePlaylistId, selected] of grouped) {
      const rows = await tx.$queryRaw<Array<{
        episodeOrder: string;
        randomPolicy: string;
        randomRound: number;
        randomConsumedEpisodeIds: unknown;
      }>>`
        SELECT
          "episodeOrder",
          "randomPolicy",
          "randomRound",
          "randomConsumedEpisodeIds"
        FROM "PodcastShowPolicy"
        WHERE "sourcePlaylistId" = ${sourcePlaylistId}
        FOR UPDATE
      `;
      const current = rows[0];
      if (!current) continue;

      if (current.episodeOrder === "RANDOM") {
        const effectiveRound = Math.max(
          current.randomRound,
          ...selected.map((entry) => entry.randomRound),
        );

        if (current.randomPolicy === "WITH_REPLACEMENT") {
          await tx.$executeRaw`
            UPDATE "PodcastShowPolicy"
            SET
              "randomRound" = ${effectiveRound + 1},
              "randomConsumedEpisodeIds" = '[]'::jsonb,
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "sourcePlaylistId" = ${sourcePlaylistId}
          `;
          continue;
        }

        const reset =
          effectiveRound > current.randomRound ||
          selected.some((entry) => entry.randomRoundReset);
        const consumed = new Set(
          reset ? [] : normalizeEpisodeIdArray(current.randomConsumedEpisodeIds),
        );
        for (const entry of selected) consumed.add(entry.spotifyEpisodeId);
        const serialized = JSON.stringify([...consumed].sort());
        await tx.$executeRaw`
          UPDATE "PodcastShowPolicy"
          SET
            "randomRound" = ${effectiveRound},
            "randomConsumedEpisodeIds" = ${serialized}::jsonb,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "sourcePlaylistId" = ${sourcePlaylistId}
        `;
        continue;
      }

      const stateful = selected
        .filter((entry) => entry.sequenceStateful && entry.sequenceIndex !== null)
        .sort((a, b) => (a.sequenceIndex ?? -1) - (b.sequenceIndex ?? -1));
      const last = stateful.at(-1);
      if (!last) continue;

      await tx.$executeRaw`
        UPDATE "PodcastShowPolicy"
        SET
          "sequenceCursorEpisodeId" = ${last.nextSequenceEpisodeId},
          "sequenceCompleted" = ${last.nextSequenceEpisodeId === null},
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "sourcePlaylistId" = ${sourcePlaylistId}
      `;
    }
  });
}

function normalizePolicyRow(row: PolicyRow): PodcastShowPolicySnapshot {
  return {
    sourcePlaylistId: row.sourcePlaylistId,
    episodeEligibility: isEpisodeEligibility(row.episodeEligibility)
      ? row.episodeEligibility
      : row.includePlayed
        ? "ALL"
        : "UNPLAYED_ONLY",
    episodeOrder: isEpisodeOrder(row.episodeOrder)
      ? row.episodeOrder
      : row.legacyEpisodeOrder === "NEWEST_FIRST"
        ? "NEWEST_FIRST"
        : "OLDEST_FIRST",
    randomPolicy: isRandomPolicy(row.randomPolicy)
      ? row.randomPolicy
      : "WITHOUT_REPLACEMENT",
    startEpisodeId: normalizedId(row.startEpisodeId),
    strictSequence: row.strictSequence ?? true,
    maxReleaseAgeDays: normalizeNullableNonNegativeInt(row.maxReleaseAgeDays),
    expiryPolicy: isExpiryPolicy(row.expiryPolicy)
      ? row.expiryPolicy
      : "STRICT_EXPIRY",
    maxEpisodesPerCycle: normalizeNullablePositiveInt(row.maxEpisodesPerCycle),
    sequenceCursorEpisodeId: normalizedId(row.sequenceCursorEpisodeId),
    sequenceCompleted: row.sequenceCompleted ?? false,
    randomRound: Math.max(0, Math.trunc(row.randomRound ?? 0)),
    randomConsumedEpisodeIds: normalizeEpisodeIdArray(row.randomConsumedEpisodeIds),
  };
}

function normalizeEpisodeIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    const normalized = typeof entry === "string" ? normalizedId(entry) : null;
    return normalized ? [normalized] : [];
  }))];
}

function normalizedId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeNullablePositiveInt(value: number | null): number | null {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function normalizeNullableNonNegativeInt(value: number | null): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function isEpisodeEligibility(value: string | null): value is PodcastEpisodeEligibilityValue {
  return value === "UNPLAYED_ONLY" || value === "PLAYED_ONLY" || value === "ALL";
}

function isEpisodeOrder(value: string | null): value is PodcastShowOrderValue {
  return value === "OLDEST_FIRST" || value === "NEWEST_FIRST" || value === "RANDOM";
}

function isRandomPolicy(value: string | null): value is PodcastRandomPolicyValue {
  return value === "WITHOUT_REPLACEMENT" || value === "WITH_REPLACEMENT";
}

function isExpiryPolicy(value: string | null): value is PodcastExpiryPolicyValue {
  return value === "STRICT_EXPIRY" || value === "ALLOW_IN_PROGRESS_TO_FINISH";
}

// Keeps the Prisma import live in builds where tagged-template inference varies.
export type PodcastShowPolicyTransactionClient = Prisma.TransactionClient;
