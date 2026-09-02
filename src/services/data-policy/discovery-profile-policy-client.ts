import type { PrismaClient } from "@prisma/client";

import { isDiscoveryListeningEventAllowed } from "./discovery-profile-policy";

const PROJECTED_DISCOVERY_HISTORY_MARKER =
  "/* PERF-01: project only the Extended History facts consumed by DISCOVERY */";

type ProjectedHistoryPolicyRow = Readonly<{
  id: string;
  source: string;
  extendedEvidencePresent?: boolean;
}> &
  Record<string, unknown>;

type ExecuteRaw = <T = unknown>(
  query: string,
  ...values: unknown[]
) => Promise<T>;

/**
 * Gate 5A productive DISCOVERY boundary.
 *
 * The projected profile loader is intentionally kept as the canonical
 * aggregation implementation. This adapter changes only which inputs are
 * allowed to cross into it:
 *
 * - TrackListeningEvent rows are evaluated before aggregation.
 * - projected mixed Spotify lineage remains visible through
 *   extendedEvidencePresent.
 * - legacy INFERRED_SKIP is quarantined because the current signal is derived
 *   from Spotify Recently Played and has no typed origin field.
 * - TrackListeningState is quarantined because its aggregate row has no
 *   provenance and Gate 1 proved Spotify observations update it.
 * - Last.fm backfill coverage metadata is also withheld from the compliant
 *   discovery profile while Last.fm remains REVIEW_REQUIRED.
 *
 * No underlying provider-derived rows are deleted or rewritten.
 */
export function createCompliantDiscoveryProfileClient(
  client: PrismaClient,
): PrismaClient {
  const executeRaw = client.$queryRawUnsafe.bind(client) as ExecuteRaw;

  const guardedRawQuery: ExecuteRaw = async <T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T> => {
    if (!query.includes(PROJECTED_DISCOVERY_HISTORY_MARKER)) {
      return executeRaw<T>(query, ...values);
    }

    return loadAllowedProjectedHistoryRows(
      executeRaw,
      query,
      values,
    ) as Promise<T>;
  };

  // This narrow Prisma-shaped client is consumed by PERF-01's projected
  // adapter, which in turn exposes exactly the delegates used by the batched
  // profile loader. Avoid Proxy so Prisma internals are never intercepted.
  return {
    user: client.user,
    musicPreferenceSignal: {
      findMany: async () => [],
    },
    trackListeningState: {
      findMany: async () => [],
    },
    musicPlaybackPolicy: client.musicPlaybackPolicy,
    lastFmBackfillRun: {
      findFirst: async () => null,
    },
    $queryRawUnsafe: guardedRawQuery,
  } as unknown as PrismaClient;
}

async function loadAllowedProjectedHistoryRows(
  executeRaw: ExecuteRaw,
  query: string,
  originalValues: unknown[],
): Promise<ProjectedHistoryPolicyRow[]> {
  const [userId, initialCursor, requestedTake, ...unexpected] = originalValues;
  if (unexpected.length > 0) {
    throw new Error("Gate 5 discovery history received unexpected SQL parameters");
  }
  if (typeof userId !== "string" || !userId) {
    throw new Error("Gate 5 discovery history requires a user id");
  }
  if (initialCursor !== null && typeof initialCursor !== "string") {
    throw new Error("Gate 5 discovery history cursor must be string or null");
  }
  if (
    typeof requestedTake !== "number" ||
    !Number.isInteger(requestedTake) ||
    requestedTake < 1
  ) {
    throw new Error("Gate 5 discovery history requires a positive integer take");
  }

  const allowed: ProjectedHistoryPolicyRow[] = [];
  let cursor = initialCursor;

  for (;;) {
    const physicalPage = await executeRaw<ProjectedHistoryPolicyRow[]>(
      query,
      userId,
      cursor,
      requestedTake,
    );

    if (!Array.isArray(physicalPage)) {
      throw new Error("Gate 5 discovery history query did not return an array");
    }
    if (physicalPage.length === 0) return allowed;

    let lastPhysicalId: string | null = null;
    for (const row of physicalPage) {
      if (typeof row?.id !== "string" || !row.id) {
        throw new Error("Gate 5 discovery history row is missing id");
      }
      if (typeof row.source !== "string" || !row.source) {
        throw new Error("Gate 5 discovery history row is missing source");
      }

      lastPhysicalId = row.id;
      if (
        isDiscoveryListeningEventAllowed({
          source: row.source,
          spotifyExtendedHistoryPresent:
            row.extendedEvidencePresent === true,
        })
      ) {
        allowed.push(row);
        if (allowed.length === requestedTake) return allowed;
      }
    }

    if (physicalPage.length < requestedTake) return allowed;
    if (!lastPhysicalId || lastPhysicalId === cursor) {
      throw new Error("Gate 5 discovery history cursor did not advance");
    }
    cursor = lastPhysicalId;
  }
}
