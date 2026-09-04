import type { PrismaClient } from "@prisma/client";

import type { LastFmRecentTracksReader } from "./lastfm-coverage-reader";
import {
  buildMusic06LastFmGapShadowReport,
  type Music06LastFmGapReport,
} from "./lastfm-gap-shadow-report";
import {
  projectMusic06NegativeShadow,
  type Music06NegativeProjectionShadow,
} from "./lastfm-negative-projection-shadow";

export type Music06NegativeProjectionShadowReport = Readonly<{
  mode: "SHADOW_READ_ONLY";
  userId: string;
  username: string;
  generationRunIds: readonly string[];
  sourceReports: readonly Music06LastFmGapReport[];
  projection: Music06NegativeProjectionShadow;
}>;

/**
 * Gate 4 orchestration for one or more explicitly selected generation runs.
 *
 * The same fixed `asOf` timestamp is used for every provider observation so the
 * aggregate is deterministic within a report. The path remains fully read-only.
 */
export async function buildMusic06NegativeProjectionShadowReport(input: {
  userId: string;
  generationRunIds: readonly string[];
  username: string;
  apiKey?: string;
  lastFmClient?: LastFmRecentTracksReader;
  prismaClient?: PrismaClient;
  asOf?: Date;
  maxPages?: number;
  defaultWindowHours?: number;
}): Promise<Music06NegativeProjectionShadowReport> {
  const asOf = input.asOf ?? new Date();
  if (!(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) {
    throw new Error("MUSIC-06 Gate 4 requires valid asOf");
  }

  const username = input.username.trim();
  if (!username) throw new Error("MUSIC-06 Gate 4 requires Last.fm username");

  const generationRunIds = [...new Set(input.generationRunIds.map((id) => id.trim()))]
    .filter(Boolean);
  if (generationRunIds.length === 0) {
    throw new Error("MUSIC-06 Gate 4 requires at least one generationRunId");
  }

  const sourceReports: Music06LastFmGapReport[] = [];
  for (const generationRunId of generationRunIds) {
    sourceReports.push(
      await buildMusic06LastFmGapShadowReport({
        userId: input.userId,
        generationRunId,
        username,
        apiKey: input.apiKey,
        lastFmClient: input.lastFmClient,
        prismaClient: input.prismaClient,
        observedAt: asOf,
        maxPages: input.maxPages,
        defaultWindowHours: input.defaultWindowHours,
      }),
    );
  }

  return {
    mode: "SHADOW_READ_ONLY",
    userId: input.userId,
    username,
    generationRunIds,
    sourceReports,
    projection: projectMusic06NegativeShadow({ reports: sourceReports, asOf }),
  };
}
