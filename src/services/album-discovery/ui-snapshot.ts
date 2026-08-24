import { unstable_cache } from "next/cache";

import { getAlbumOpportunityReport } from "./opportunity-report";
import { loadAlbumRecommendationMemories } from "./queue-memory";
import {
  albumCoverageSummary,
  albumRecommendationReasons,
} from "./ui-presentation";

const ALBUM_UI_SNAPSHOT_VERSION = "album-ui-snapshot-v1";
const ALBUM_UI_SNAPSHOT_REVALIDATE_SECONDS = 30 * 60;
const ALBUM_UI_SNAPSHOT_CANDIDATE_POOL = 20;
const ALBUM_UI_VISIBLE_LIMIT = 5;

export type AlbumUiSnapshotRecommendation = {
  spotifyAlbumId: string;
  artistName: string;
  albumName: string;
  releaseDate: string | null;
  score: number;
  coveragePercent: number;
  coverageSummary: string;
  plays30d: number;
  reasons: string[];
};

export type AlbumUiSnapshot = {
  version: typeof ALBUM_UI_SNAPSHOT_VERSION;
  generatedAt: string;
  providerFailureCount: number;
  recommendations: AlbumUiSnapshotRecommendation[];
};

export type AlbumUiRecommendations = AlbumUiSnapshot & {
  queuedCount: number;
  visibleRecommendations: AlbumUiSnapshotRecommendation[];
};

export async function getAlbumUiSnapshot(userId: string): Promise<AlbumUiSnapshot> {
  const cached = unstable_cache(
    () => computeAlbumUiSnapshot(userId),
    [ALBUM_UI_SNAPSHOT_VERSION, userId],
    { revalidate: ALBUM_UI_SNAPSHOT_REVALIDATE_SECONDS },
  );

  return cached();
}

export async function getAlbumUiRecommendations(userId: string): Promise<AlbumUiRecommendations> {
  const [snapshot, memories] = await Promise.all([
    getAlbumUiSnapshot(userId),
    loadAlbumRecommendationMemories(userId),
  ]);

  const queuedAlbumIds = new Set(
    memories
      .filter((memory) => memory.state === "QUEUED")
      .map((memory) => memory.spotifyAlbumId),
  );

  return {
    ...snapshot,
    queuedCount: queuedAlbumIds.size,
    visibleRecommendations: filterQueuedAlbumUiRecommendations(
      snapshot.recommendations,
      queuedAlbumIds,
      ALBUM_UI_VISIBLE_LIMIT,
    ),
  };
}

export function filterQueuedAlbumUiRecommendations(
  recommendations: AlbumUiSnapshotRecommendation[],
  queuedAlbumIds: ReadonlySet<string>,
  limit = ALBUM_UI_VISIBLE_LIMIT,
): AlbumUiSnapshotRecommendation[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Album UI recommendation limit must be a positive integer");
  }

  return recommendations
    .filter((recommendation) => !queuedAlbumIds.has(recommendation.spotifyAlbumId))
    .slice(0, limit);
}

async function computeAlbumUiSnapshot(userId: string): Promise<AlbumUiSnapshot> {
  const report = await getAlbumOpportunityReport(userId, {
    artistLimit: 5,
    top: ALBUM_UI_SNAPSHOT_CANDIDATE_POOL,
  });

  return {
    version: ALBUM_UI_SNAPSHOT_VERSION,
    generatedAt: report.generatedAt.toISOString(),
    providerFailureCount: report.providerMetrics.failures.length,
    recommendations: report.ranked.map((candidate) => ({
      spotifyAlbumId: candidate.spotifyAlbumId,
      artistName: candidate.artistName,
      albumName: candidate.albumName,
      releaseDate: candidate.releaseDate,
      score: candidate.score,
      coveragePercent: Math.round((candidate.coverage.analyticCoverage ?? 0) * 100),
      coverageSummary: albumCoverageSummary(candidate),
      plays30d: candidate.coverage.plays30d,
      reasons: albumRecommendationReasons(candidate, 3),
    })),
  };
}
