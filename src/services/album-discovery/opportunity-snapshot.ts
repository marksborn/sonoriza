import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { AlbumOpportunityCandidate } from "./opportunity";
import { getAlbumOpportunityReport } from "./opportunity-report";
import { loadAlbumRecommendationMemories } from "./queue-memory";

export const ALBUM_OPPORTUNITY_SNAPSHOT_POLICY = {
  version: "album-ui-opportunity-snapshot-v1",
  refreshAfterMs: 12 * 60 * 60_000,
  staleAfterMs: 48 * 60 * 60_000,
  persistedCandidateCount: 50,
  uiDefaultTop: 5,
  note:
    "ALBUM-01 is computed outside the page request and persisted as an atomic filesystem cache. The snapshot is advisory/read-only; QUEUED memory remains authoritative and is re-applied on every UI read.",
} as const;

type SerializedAlbumOpportunityCandidate = Omit<AlbumOpportunityCandidate, "coverage"> & {
  coverage: Omit<
    AlbumOpportunityCandidate["coverage"],
    "firstObservedAt" | "lastObservedAt"
  > & {
    firstObservedAt: string | null;
    lastObservedAt: string | null;
  };
};

export type AlbumOpportunitySnapshotPayload = {
  version: typeof ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.version;
  generatedAt: string;
  asOf: string;
  candidateCount: number;
  providerFailureCount: number;
  ranked: SerializedAlbumOpportunityCandidate[];
};

export type AlbumOpportunitySnapshotStatus = "READY" | "STALE" | "MISSING";

export type AlbumOpportunitySnapshotView = {
  snapshot: {
    status: AlbumOpportunitySnapshotStatus;
    generatedAt: Date | null;
    asOf: Date | null;
    ageMs: number | null;
    source: typeof ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.version;
  };
  ranked: AlbumOpportunityCandidate[];
  queueMemory: {
    queuedCount: number;
    suppressedAlbumCount: number;
  };
  providerMetrics: {
    failureCount: number;
  };
};

export type RefreshAlbumOpportunitySnapshotResult = {
  userId: string;
  generatedAt: Date;
  candidateCount: number;
  persistedCandidateCount: number;
  providerFailureCount: number;
  filePath: string;
};

export async function refreshAlbumOpportunitySnapshot(
  userId: string,
  input: { asOf?: Date } = {},
): Promise<RefreshAlbumOpportunitySnapshotResult> {
  const asOf = input.asOf ?? new Date();
  const report = await getAlbumOpportunityReport(userId, {
    asOf,
    artistLimit: 5,
    top: ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.persistedCandidateCount,
  });

  const payload = serializeAlbumOpportunitySnapshotPayload({
    generatedAt: report.generatedAt,
    asOf: report.asOf,
    candidateCount: report.candidateCount,
    providerFailureCount: report.providerMetrics.failures.length,
    ranked: report.ranked,
  });
  const filePath = await writeSnapshot(userId, payload);

  return {
    userId,
    generatedAt: new Date(payload.generatedAt),
    candidateCount: payload.candidateCount,
    persistedCandidateCount: payload.ranked.length,
    providerFailureCount: payload.providerFailureCount,
    filePath,
  };
}

export async function getAlbumOpportunitySnapshotView(
  userId: string,
  input: { top?: number; now?: Date } = {},
): Promise<AlbumOpportunitySnapshotView> {
  const top = clampInteger(
    input.top ?? ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.uiDefaultTop,
    1,
    20,
  );
  const now = input.now ?? new Date();

  const [payload, memories] = await Promise.all([
    readAlbumOpportunitySnapshot(userId),
    loadAlbumRecommendationMemories(userId),
  ]);
  const queuedIds = new Set(
    memories
      .filter((memory) => memory.state === "QUEUED")
      .map((memory) => memory.spotifyAlbumId),
  );
  const queuedCount = queuedIds.size;

  if (!payload) {
    return {
      snapshot: {
        status: "MISSING",
        generatedAt: null,
        asOf: null,
        ageMs: null,
        source: ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.version,
      },
      ranked: [],
      queueMemory: {
        queuedCount,
        suppressedAlbumCount: 0,
      },
      providerMetrics: {
        failureCount: 0,
      },
    };
  }

  const generatedAt = new Date(payload.generatedAt);
  const asOf = new Date(payload.asOf);
  const ageMs = Math.max(0, now.getTime() - generatedAt.getTime());
  const hydrated = hydrateAlbumOpportunitySnapshotCandidates(payload.ranked);
  const selected = selectSnapshotCandidates(hydrated, queuedIds, top);

  return {
    snapshot: {
      status:
        ageMs > ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.staleAfterMs ? "STALE" : "READY",
      generatedAt,
      asOf,
      ageMs,
      source: ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.version,
    },
    ranked: selected.candidates,
    queueMemory: {
      queuedCount,
      suppressedAlbumCount: selected.suppressedAlbumCount,
    },
    providerMetrics: {
      failureCount: payload.providerFailureCount,
    },
  };
}

export async function getAlbumOpportunitySnapshotRefreshState(
  userId: string,
  now: Date = new Date(),
): Promise<{
  status: AlbumOpportunitySnapshotStatus;
  generatedAt: Date | null;
  ageMs: number | null;
  shouldRefresh: boolean;
}> {
  const payload = await readAlbumOpportunitySnapshot(userId);
  if (!payload) {
    return {
      status: "MISSING",
      generatedAt: null,
      ageMs: null,
      shouldRefresh: true,
    };
  }

  const generatedAt = new Date(payload.generatedAt);
  const ageMs = Math.max(0, now.getTime() - generatedAt.getTime());
  return {
    status:
      ageMs > ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.staleAfterMs ? "STALE" : "READY",
    generatedAt,
    ageMs,
    shouldRefresh: ageMs >= ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.refreshAfterMs,
  };
}

export function serializeAlbumOpportunitySnapshotPayload(input: {
  generatedAt: Date;
  asOf: Date;
  candidateCount: number;
  providerFailureCount: number;
  ranked: AlbumOpportunityCandidate[];
}): AlbumOpportunitySnapshotPayload {
  return {
    version: ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.version,
    generatedAt: input.generatedAt.toISOString(),
    asOf: input.asOf.toISOString(),
    candidateCount: input.candidateCount,
    providerFailureCount: input.providerFailureCount,
    ranked: input.ranked.map((candidate) => ({
      ...candidate,
      coverage: {
        ...candidate.coverage,
        firstObservedAt: candidate.coverage.firstObservedAt?.toISOString() ?? null,
        lastObservedAt: candidate.coverage.lastObservedAt?.toISOString() ?? null,
      },
    })),
  };
}

export function hydrateAlbumOpportunitySnapshotCandidates(
  rows: SerializedAlbumOpportunityCandidate[],
): AlbumOpportunityCandidate[] {
  return rows.map((candidate) => ({
    ...candidate,
    coverage: {
      ...candidate.coverage,
      firstObservedAt: candidate.coverage.firstObservedAt
        ? new Date(candidate.coverage.firstObservedAt)
        : null,
      lastObservedAt: candidate.coverage.lastObservedAt
        ? new Date(candidate.coverage.lastObservedAt)
        : null,
    },
  }));
}

export function selectSnapshotCandidates(
  candidates: AlbumOpportunityCandidate[],
  queuedIds: ReadonlySet<string>,
  top: number,
): { candidates: AlbumOpportunityCandidate[]; suppressedAlbumCount: number } {
  const limit = clampInteger(top, 1, 20);
  const selected: AlbumOpportunityCandidate[] = [];
  let suppressedAlbumCount = 0;

  for (const candidate of candidates) {
    if (queuedIds.has(candidate.spotifyAlbumId)) {
      suppressedAlbumCount += 1;
      continue;
    }
    selected.push(candidate);
    if (selected.length >= limit) break;
  }

  return { candidates: selected, suppressedAlbumCount };
}

async function readAlbumOpportunitySnapshot(
  userId: string,
): Promise<AlbumOpportunitySnapshotPayload | null> {
  const filePath = snapshotFilePath(userId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isSnapshotPayload(parsed)) {
    throw new Error(`Invalid ALBUM-01 snapshot payload at ${filePath}`);
  }
  return parsed;
}

async function writeSnapshot(
  userId: string,
  payload: AlbumOpportunitySnapshotPayload,
): Promise<string> {
  const directory = snapshotDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  const filePath = snapshotFilePath(userId);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tempPath, filePath);
    return filePath;
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function snapshotDirectory(): string {
  return (
    process.env.ALBUM_OPPORTUNITY_SNAPSHOT_DIR?.trim() ||
    path.join(homedir(), ".sonoriza-cache", "album-opportunity")
  );
}

function snapshotFilePath(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 32);
  return path.join(snapshotDirectory(), `${digest}.json`);
}

function isSnapshotPayload(value: unknown): value is AlbumOpportunitySnapshotPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AlbumOpportunitySnapshotPayload>;
  return (
    candidate.version === ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.version &&
    typeof candidate.generatedAt === "string" &&
    typeof candidate.asOf === "string" &&
    typeof candidate.candidateCount === "number" &&
    typeof candidate.providerFailureCount === "number" &&
    Array.isArray(candidate.ranked)
  );
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
