import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import { LastFmClient } from "@/services/lastfm/client";

import {
  assessLastFmCoverage,
  type LastFmCoverageAssessment,
  type LastFmRecentObservation,
} from "./lastfm-coverage";
import {
  readLastFmRecentObservation,
  type LastFmRecentTracksReader,
} from "./lastfm-coverage-reader";
import {
  loadPublishedMusicRun,
  type PublishedMusicRun,
} from "./lastfm-coverage-prisma";

export const MUSIC_06_LASTFM_DEFAULT_WINDOW_HOURS = 24;

export type Music06LastFmCoverageTargetReport = Readonly<{
  targetPlaylistId: string;
  assessment: LastFmCoverageAssessment;
}>;

export type Music06LastFmCoverageShadowReport = Readonly<{
  mode: "SHADOW_READ_ONLY";
  userId: string;
  username: string;
  generationRunId: string;
  publishedAt: Date;
  requestedFrom: Date;
  requestedTo: Date;
  providerStatus: "AVAILABLE" | "UNAVAILABLE";
  providerError: string | null;
  observation: LastFmRecentObservation | null;
  targets: readonly Music06LastFmCoverageTargetReport[];
}>;

/**
 * Gate 2 orchestration. Reads one exact persisted generation plus a bounded
 * Last.fm window and evaluates coverage. It deliberately performs no write and
 * does not create `INFERRED_SKIP`; Gate 3 owns gap inference.
 */
export async function buildMusic06LastFmCoverageShadowReport(input: {
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
}): Promise<Music06LastFmCoverageShadowReport> {
  const client = input.prismaClient ?? defaultPrisma;
  const published = await loadPublishedMusicRun(
    input.userId,
    input.generationRunId,
    client,
  );
  const observedAt = input.observedAt ?? new Date();
  const requestedFrom = resolveRequestedFrom(input.from, published);
  const requestedTo = resolveRequestedTo({
    explicit: input.to,
    published,
    requestedFrom,
    observedAt,
    defaultWindowHours:
      input.defaultWindowHours ?? MUSIC_06_LASTFM_DEFAULT_WINDOW_HOURS,
  });
  const username = input.username.trim();
  if (!username) throw new Error("MUSIC-06 coverage shadow requires Last.fm username");

  const lastFmClient =
    input.lastFmClient ??
    new LastFmClient({ apiKey: requiredApiKey(input.apiKey) });

  let observation: LastFmRecentObservation | null = null;
  let providerError: string | null = null;

  try {
    observation = await readLastFmRecentObservation({
      client: lastFmClient,
      username,
      from: requestedFrom,
      to: requestedTo,
      observedAt,
      maxPages: input.maxPages,
    });
  } catch (error) {
    providerError = error instanceof Error ? error.message : String(error);
  }

  return {
    mode: "SHADOW_READ_ONLY",
    userId: input.userId,
    username,
    generationRunId: published.generationRunId,
    publishedAt: published.publishedAt,
    requestedFrom,
    requestedTo,
    providerStatus: observation ? "AVAILABLE" : "UNAVAILABLE",
    providerError,
    observation,
    targets: published.targets.map((target) => ({
      targetPlaylistId: target.targetPlaylistId,
      assessment: assessLastFmCoverage({
        occurrences: target.occurrences,
        observation,
        unavailableReason: providerError,
      }),
    })),
  };
}

function resolveRequestedFrom(
  explicit: Date | undefined,
  published: PublishedMusicRun,
): Date {
  if (!explicit) return published.publishedAt;
  assertValidDate(explicit, "from");
  // A play before the generation was published cannot belong to this published
  // occurrence set. Clamp rather than widening behavioral evidence backwards.
  return explicit < published.publishedAt ? published.publishedAt : explicit;
}

function resolveRequestedTo(input: {
  explicit: Date | undefined;
  published: PublishedMusicRun;
  requestedFrom: Date;
  observedAt: Date;
  defaultWindowHours: number;
}): Date {
  assertValidDate(input.observedAt, "observedAt");
  if (input.explicit) {
    assertValidDate(input.explicit, "to");
    if (input.explicit > input.observedAt) {
      throw new Error("MUSIC-06 coverage shadow cannot request Last.fm future time");
    }
    if (input.explicit <= input.requestedFrom) {
      throw new Error("MUSIC-06 coverage shadow requires from < to");
    }
    return input.explicit;
  }

  if (
    !Number.isFinite(input.defaultWindowHours) ||
    input.defaultWindowHours <= 0
  ) {
    throw new Error("MUSIC-06 coverage shadow defaultWindowHours must be positive");
  }

  const horizon = new Date(
    input.requestedFrom.getTime() + input.defaultWindowHours * 60 * 60 * 1000,
  );
  const requestedTo =
    horizon < input.observedAt ? horizon : new Date(input.observedAt.getTime());
  if (requestedTo <= input.requestedFrom) {
    throw new Error("MUSIC-06 coverage shadow has no elapsed observation window yet");
  }
  return requestedTo;
}

function requiredApiKey(apiKey: string | undefined): string {
  const value = apiKey?.trim() ?? "";
  if (!value) throw new Error("MUSIC-06 coverage shadow requires Last.fm API key");
  return value;
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`MUSIC-06 coverage shadow requires valid ${label}`);
  }
}
