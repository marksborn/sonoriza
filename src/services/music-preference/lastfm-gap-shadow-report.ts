import type { PrismaClient } from "@prisma/client";

import type { LastFmRecentTracksReader } from "./lastfm-coverage-reader";
import {
  buildMusic06LastFmCoverageShadowReport,
  type Music06LastFmCoverageShadowReport,
} from "./lastfm-coverage-shadow";
import {
  inferMusic06LastFmGapShadow,
  type Music06LastFmGapShadowResult,
} from "./lastfm-gap-shadow";

export type Music06LastFmGapTargetShadowReport = Readonly<{
  targetPlaylistId: string;
  coverageStatus: "CONFIRMED" | "PARTIAL" | "UNKNOWN" | "UNAVAILABLE";
  shadow: Music06LastFmGapShadowResult;
}>;

export type Music06LastFmGapReport = Readonly<{
  mode: "SHADOW_READ_ONLY";
  coverage: Music06LastFmCoverageShadowReport;
  assessedWindowCount: number;
  inferredGapCount: number;
  targets: readonly Music06LastFmGapTargetShadowReport[];
}>;

/**
 * Gate 3 orchestration. Reuses the Gate 2 read-only coverage report and applies
 * only the pure shadow detector. No preference signal or playlist write exists
 * on this path.
 */
export async function buildMusic06LastFmGapShadowReport(input: {
  userId: string;
  generationRunId: string;
  username: string;
  apiKey?: string;
  lastFmClient?: LastFmRecentTracksReader;
  prismaClient?: PrismaClient;
  from?: Date;
  to?: Date;
  observedAt?: Date;
  maxPages?: number;
  defaultWindowHours?: number;
}): Promise<Music06LastFmGapReport> {
  const coverage = await buildMusic06LastFmCoverageShadowReport(input);
  const targets = coverage.targets.map((target) => ({
    targetPlaylistId: target.targetPlaylistId,
    coverageStatus: target.assessment.status,
    shadow: inferMusic06LastFmGapShadow(target.assessment),
  }));

  return {
    mode: "SHADOW_READ_ONLY",
    coverage,
    assessedWindowCount: targets.reduce(
      (sum, target) => sum + target.shadow.assessedWindowCount,
      0,
    ),
    inferredGapCount: targets.reduce(
      (sum, target) => sum + target.shadow.inferredGapCount,
      0,
    ),
    targets,
  };
}
