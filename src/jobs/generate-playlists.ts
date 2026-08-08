import type { RunStatus, RunTrigger, TargetPlaylist } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  computeCalendarDuration,
  type CalendarDurationResult,
} from "@/services/google-calendar";
import {
  parseSequencePattern,
  planRun,
  type Candidate,
  type PlannerPools,
  type RunTarget,
} from "@/services/playlist-planner";
import {
  isSpotifyApiError,
  SpotifyClient,
  type PodcastCandidateBatch,
  type SpotifyApiErrorKind,
} from "@/services/spotify";

export interface GeneratePlaylistsOptions {
  userId: string;
  trigger: RunTrigger;
  /** When true, plans and records the run but never writes to Spotify. */
  simulate?: boolean;
  /** Day used to resolve calendar-based durations. Defaults to now. */
  date?: Date;
}

export interface GeneratePlaylistsResult {
  runId: string;
  status: RunStatus;
}

type LogLine = { level: "INFO" | "WARN" | "ERROR"; message: string; data?: unknown };

type ResolvedTargetDuration = {
  durationMs: number;
  calendar: CalendarDurationResult | null;
};

type SourceCollectionFailure = {
  source: string;
  kind: string;
  spotifyType: string;
  spotifyId: string;
  errorKind: SpotifyApiErrorKind | "SOURCE_READ_FAILED";
  status: number | null;
  reason: string | null;
  operation: string | null;
  retryAfterSeconds: number | null;
};

type PoolBuildResult = {
  pools: PlannerPools;
  configuredSourceCount: number;
  readSourceCount: number;
  failures: SourceCollectionFailure[];
};

/**
 * End-to-end generation for one user:
 *   1. build candidate pools from the user's Spotify sources;
 *   2. resolve each target's duration (fixed or from the calendar);
 *   3. plan every target in priority order (cross-playlist exclusivity);
 *   4. validate plan quality before any real Spotify write;
 *   5. apply the plans to Spotify (unless simulating);
 *   6. persist the run, its items, logs and a structured summary.
 *
 * A failure while applying a single target degrades the run to PARTIAL rather
 * than aborting the others. A material planning-quality failure aborts before
 * any target is written, because applying a known-bad mix would be destructive.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const { userId, trigger } = opts;
  const simulate = opts.simulate ?? trigger === "SIMULATION";
  const date = opts.date ?? new Date();

  const run = await prisma.generationRun.create({
    data: { userId, trigger, simulation: simulate, status: "RUNNING" },
  });

  const logs: LogLine[] = [];
  const log = (line: LogLine) => logs.push(line);
  const summary: Record<string, unknown> = {
    simulate,
    targets: [] as unknown[],
    qualityPassed: false,
    collectionComplete: false,
    inconclusive: false,
  };

  let status: RunStatus = "SUCCESS";
  let spotify: SpotifyClient | null = null;

  try {
    spotify = await SpotifyClient.forUser(userId);

    // --- 1. Build shared candidate pools -----------------------------------
    const sources = await prisma.sourcePlaylist.findMany({
      where: { userId, enabled: true },
    });

    const poolBuild = await buildPools(spotify, sources, log);
    const pools = poolBuild.pools;
    const collectionComplete = poolBuild.failures.length === 0;

    summary.collectionComplete = collectionComplete;
    summary.sourceCollection = {
      configuredSourceCount: poolBuild.configuredSourceCount,
      readSourceCount: poolBuild.readSourceCount,
      unavailableSourceCount: poolBuild.failures.length,
      failures: poolBuild.failures,
    };
    summary.spotifyApi = spotify.getRequestMetrics();

    log({
      level: "INFO",
      message: `Pools built: ${pools.music.length} tracks, ${pools.podcasts.length} episodes`,
    });

    // An unread enabled source means the planner does not know whether content
    // is actually unavailable. Stop before planning so a partial pool can never
    // be misreported as a configuration/mix failure and can never reach writes.
    if (!collectionComplete) {
      status = "FAILED";
      summary.inconclusive = true;
      summary.inconclusiveReason = collectionFailureReason(poolBuild.failures);
      summary.qualityPassed = false;
      summary.qualityFailures = [];

      const error = collectionFailureMessage(poolBuild.failures, simulate);
      log({
        level: "WARN",
        message: error,
        data: {
          configuredSourceCount: poolBuild.configuredSourceCount,
          readSourceCount: poolBuild.readSourceCount,
          unavailableSourceCount: poolBuild.failures.length,
          failures: poolBuild.failures,
        },
      });
      await finalizeRun(run.id, status, logs, summary, error);
      return { runId: run.id, status };
    }

    // --- 2. Resolve targets + durations ------------------------------------
    const targets = await prisma.targetPlaylist.findMany({
      where: { userId, enabled: true },
      orderBy: { priority: "asc" },
    });

    const durationCalendarIds = (
      await prisma.calendarSelection.findMany({
        where: { userId, selected: true, usedForDuration: true },
      })
    ).map((c) => c.googleCalendarId);

    const runTargets: RunTarget[] = [];
    const skipped: TargetPlaylist[] = [];
    const resolvedDurationByTargetId = new Map<string, ResolvedTargetDuration>();

    for (const target of targets) {
      const resolved = await resolveTargetDuration(
        userId,
        target,
        durationCalendarIds,
        date,
        log,
      );
      resolvedDurationByTargetId.set(target.id, resolved);
      const durationMs = resolved.durationMs;

      // Calendar target with no eligible events → apply the configured empty behaviour.
      if (target.durationMode === "CALENDAR" && durationMs <= 0) {
        if (target.emptyCalendarBehavior === "CLEAR") {
          log({
            level: "INFO",
            message: `Target "${target.name}" has no eligible calendar events → will be cleared`,
          });
          runTargets.push(toRunTarget(target, 0));
        } else {
          log({
            level: "INFO",
            message: `Target "${target.name}" has no eligible calendar events → ${target.emptyCalendarBehavior} (untouched)`,
          });
          skipped.push(target);
        }
        continue;
      }

      runTargets.push(toRunTarget(target, durationMs));
    }

    // --- 3. Plan (priority order, shared reservation) ----------------------
    const plan = planRun({ pools, targets: runTargets });
    const qualityFailures = plan.targets.filter(
      (planned) => !planned.result.stats.mixQualityPassed,
    );

    summary.qualityPassed = qualityFailures.length === 0;
    summary.qualityFailures = qualityFailures.map((planned) => ({
      name: planned.name,
      requestedPodcastPercent: planned.result.stats.requestedPodcastPercent,
      actualPodcastPercent: planned.result.stats.actualPodcastPercent,
      mixDeviationPoints: planned.result.stats.mixDeviationPoints,
      podcastShortfallMs: planned.result.stats.podcastShortfallMs,
      musicShortfallMs: planned.result.stats.musicShortfallMs,
      poolExhausted: planned.result.stats.poolExhausted,
      reason: qualityReason(planned.result.stats),
    }));

    for (const failure of qualityFailures) {
      log({
        level: "WARN",
        message: `Target "${failure.name}" failed mix quality: ${qualityReason(failure.result.stats)}`,
      });
    }

    // Never apply a plan we already know materially violates the configured
    // duration mix. This protects real runs even if UI state became stale.
    if (!simulate && qualityFailures.length > 0) {
      status = "FAILED";
      const error =
        "A geração foi bloqueada antes de alterar o Spotify porque o plano não conseguiu atender às proporções configuradas.";
      summary.spotifyApi = spotify.getRequestMetrics();
      await finalizeRun(run.id, status, logs, summary, error);
      return { runId: run.id, status };
    }

    // --- 4 & 5. Apply + persist per target ---------------------------------
    const targetById = new Map(targets.map((t) => [t.id, t]));
    let anyFailed = false;

    for (const planned of plan.targets) {
      const target = targetById.get(planned.targetPlaylistId)!;
      const { items, stats } = planned.result;
      const resolvedDuration = resolvedDurationByTargetId.get(target.id);
      const calendar = resolvedDuration?.calendar ?? null;

      const targetSummary: Record<string, unknown> = {
        name: target.name,
        planned: items.length,
        ...stats,
        totalMinutes: Math.round(stats.totalDurationMs / 60000),
        qualityReason: stats.mixQualityPassed ? null : qualityReason(stats),
        ...(calendar
          ? {
              calendarEventCount: calendar.matchedEvents,
              calendarTimedEventCount: calendar.timedEvents,
              calendarEventFilterMode: calendar.filterMode,
              calendarEventMarker: calendar.marker,
              calendarDurationMinutes: Math.round(calendar.durationMs / 60000),
            }
          : {}),
      };

      try {
        if (!simulate) {
          const playlistId = await ensureSpotifyPlaylist(spotify, target);
          await spotify.replacePlaylistItems(
            playlistId,
            items.map((i) => i.uri),
          );
          targetSummary.applied = true;
        } else {
          targetSummary.applied = false;
        }

        await prisma.generationItem.createMany({
          data: items.map((i) => ({
            runId: run.id,
            targetPlaylistId: target.id,
            position: i.position,
            contentType: i.type,
            spotifyUri: i.uri,
            title: i.title,
            subtitle: i.subtitle,
            programId: i.programId,
            durationMs: i.durationMs,
          })),
        });

        log({
          level: "INFO",
          message: `Target "${target.name}": ${items.length} items, ${Math.round(
            stats.totalDurationMs / 60000,
          )} min, ${stats.actualPodcastPercent}% podcast${simulate ? " (simulated)" : ""}`,
        });
      } catch (err) {
        anyFailed = true;
        targetSummary.error = errorMessage(err);
        log({
          level: "ERROR",
          message: `Failed to apply target "${target.name}": ${errorMessage(err)}`,
        });
      }

      (summary.targets as unknown[]).push(targetSummary);
    }

    summary.skipped = skipped.map((t) => t.name);
    summary.spotifyApi = spotify.getRequestMetrics();
    status = anyFailed ? "PARTIAL" : "SUCCESS";

    await finalizeRun(run.id, status, logs, summary);
    return { runId: run.id, status };
  } catch (err) {
    if (spotify) summary.spotifyApi = spotify.getRequestMetrics();
    log({ level: "ERROR", message: `Run failed: ${errorMessage(err)}` });
    await finalizeRun(run.id, "FAILED", logs, summary, errorMessage(err));
    return { runId: run.id, status: "FAILED" };
  }
}

// --- helpers ----------------------------------------------------------------

async function buildPools(
  spotify: SpotifyClient,
  sources: {
    kind: string;
    spotifyType: string;
    spotifyId: string;
    name: string | null;
    includePlayed: boolean;
  }[],
  log: (line: LogLine) => void,
): Promise<PoolBuildResult> {
  const music: Candidate[] = [];
  const podcasts: Candidate[] = [];
  const failures: SourceCollectionFailure[] = [];
  let readSourceCount = 0;

  for (const source of sources) {
    try {
      if (source.kind === "MUSIC") {
        if (source.spotifyType !== "PLAYLIST") {
          throw new Error(`Unsupported music source type: ${source.spotifyType}`);
        }
        music.push(...(await spotify.getPlaylistTracks(source.spotifyId)));
        readSourceCount += 1;
        continue;
      }

      if (source.kind !== "PODCAST") continue;

      let batch: PodcastCandidateBatch | null = null;
      if (source.spotifyType === "SHOW") {
        batch = await spotify.getShowEpisodes(
          source.spotifyId,
          source.includePlayed,
        );
      } else if (source.spotifyType === "SAVED_EPISODES") {
        batch = await spotify.getSavedEpisodes(source.includePlayed);
      } else if (source.spotifyType === "PLAYLIST") {
        batch = await spotify.getPlaylistEpisodes(
          source.spotifyId,
          source.includePlayed,
        );
      }

      if (!batch) {
        throw new Error(`Unsupported podcast source type: ${source.spotifyType}`);
      }

      podcasts.push(...batch.candidates);
      logPodcastBatch(source.name ?? source.spotifyType, batch, log);
      readSourceCount += 1;
    } catch (err) {
      const spotifyError = isSpotifyApiError(err) ? err : null;
      const failure: SourceCollectionFailure = {
        source: source.name ?? `${source.spotifyType}:${source.spotifyId}`,
        kind: source.kind,
        spotifyType: source.spotifyType,
        spotifyId: source.spotifyId,
        errorKind: spotifyError?.kind ?? "SOURCE_READ_FAILED",
        status: spotifyError?.status ?? null,
        reason: spotifyError?.reason ?? null,
        operation: spotifyError?.operation ?? null,
        retryAfterSeconds: spotifyError?.retryAfterSeconds ?? null,
      };
      failures.push(failure);

      const message =
        failure.errorKind === "QUOTA_EXCEEDED"
          ? `Source "${failure.source}" was not read because Spotify quota was exceeded; collection marked incomplete`
          : failure.errorKind === "RATE_LIMITED"
            ? `Source "${failure.source}" remained rate limited after retry; collection marked incomplete`
            : `Source "${failure.source}" could not be read; collection marked incomplete: ${errorMessage(err)}`;
      log({
        level: "WARN",
        message,
        data: failure,
      });
    }
  }

  // Keep all podcast copies until planning. The planner first removes candidates
  // without a trustworthy program identity and then deduplicates by URI while
  // selecting. This prevents an invalid copy from one source from hiding a
  // valid copy of the same episode from another source.
  return {
    pools: { music: dedupeByUri(music), podcasts },
    configuredSourceCount: sources.length,
    readSourceCount,
    failures,
  };
}

function logPodcastBatch(
  label: string,
  batch: PodcastCandidateBatch,
  log: (line: LogLine) => void,
) {
  if (batch.fullyPlayedSkippedCount > 0) {
    log({
      level: "INFO",
      message: `Podcast source "${label}": ${batch.fullyPlayedSkippedCount} fully played episodes excluded`,
    });
  }
  if (batch.playbackPositionMissingCount > 0) {
    log({
      level: "WARN",
      message: `Podcast source "${label}": Spotify omitted playback position for ${batch.playbackPositionMissingCount} episodes; full duration used for those items`,
    });
  }
}

async function resolveTargetDuration(
  userId: string,
  target: TargetPlaylist,
  durationCalendarIds: string[],
  date: Date,
  log: (line: LogLine) => void,
): Promise<ResolvedTargetDuration> {
  if (target.durationMode === "FIXED") {
    return {
      durationMs: (target.fixedDurationSeconds ?? 0) * 1000,
      calendar: null,
    };
  }

  const calendar = await computeCalendarDuration(userId, durationCalendarIds, date, {
    mode: target.calendarEventFilterMode,
    marker: target.calendarEventMarker,
  });
  const filterDescription =
    calendar.filterMode === "MARKER"
      ? `marker ${calendar.marker ?? "(missing)"}`
      : "all timed events";

  log({
    level: "INFO",
    message: `Calendar duration for "${target.name}": ${calendar.matchedEvents}/${calendar.timedEvents} events (${filterDescription}), ${Math.round(calendar.durationMs / 60000)} min`,
    data: {
      matchedEvents: calendar.matchedEvents,
      timedEvents: calendar.timedEvents,
      filterMode: calendar.filterMode,
      marker: calendar.marker,
      durationMs: calendar.durationMs,
    },
  });

  return { durationMs: calendar.durationMs, calendar };
}

function toRunTarget(target: TargetPlaylist, durationMs: number): RunTarget {
  return {
    targetPlaylistId: target.id,
    name: target.name,
    priority: target.priority,
    rules: {
      targetDurationMs: durationMs,
      podcastPercent: target.podcastPercent,
      sequencePattern: parseSequencePattern(target.sequencePattern),
      maxEpisodesPerProgram: target.maxEpisodesPerProgram,
    },
  };
}

async function ensureSpotifyPlaylist(
  spotify: SpotifyClient,
  target: TargetPlaylist,
): Promise<string> {
  if (target.spotifyPlaylistId) return target.spotifyPlaylistId;
  const playlistId = await spotify.createPlaylist(
    target.name,
    "Generated by Sonoriza",
  );
  await prisma.targetPlaylist.update({
    where: { id: target.id },
    data: { spotifyPlaylistId: playlistId },
  });
  return playlistId;
}

async function finalizeRun(
  runId: string,
  status: RunStatus,
  logs: LogLine[],
  summary: Record<string, unknown>,
  error?: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.generationLog.createMany({
      data: logs.map((l) => ({
        runId,
        level: l.level,
        message: l.message,
        data: l.data === undefined ? undefined : (l.data as object),
      })),
    }),
    prisma.generationRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        error: error ?? null,
        summary: summary as object,
      },
    }),
  ]);
}

function collectionFailureReason(
  failures: SourceCollectionFailure[],
): "QUOTA_EXCEEDED" | "RATE_LIMITED" | "SOURCE_UNAVAILABLE" {
  if (failures.some((failure) => failure.errorKind === "QUOTA_EXCEEDED")) {
    return "QUOTA_EXCEEDED";
  }
  if (failures.some((failure) => failure.errorKind === "RATE_LIMITED")) {
    return "RATE_LIMITED";
  }
  return "SOURCE_UNAVAILABLE";
}

function collectionFailureMessage(
  failures: SourceCollectionFailure[],
  simulate: boolean,
): string {
  const reason = collectionFailureReason(failures);
  const prefix = simulate
    ? "Não foi possível concluir a simulação"
    : "A geração foi bloqueada antes de alterar o Spotify";
  const cause =
    reason === "QUOTA_EXCEEDED"
      ? "o Spotify atingiu a quota disponível durante a leitura das fontes"
      : reason === "RATE_LIMITED"
        ? "o Spotify limitou temporariamente a leitura de algumas fontes mesmo após a tentativa controlada de retry"
        : "uma ou mais fontes do Spotify não puderam ser lidas por completo";

  return `${prefix}: ${cause}. Nenhuma configuração foi considerada incorreta e nenhuma playlist do Spotify foi alterada.`;
}

function qualityReason(stats: {
  requestedPodcastPercent: number;
  actualPodcastPercent: number;
  podcastShortfallMs: number;
  musicShortfallMs: number;
  poolExhausted: boolean;
  mixDeviationPoints: number;
}): string {
  if (stats.poolExhausted) {
    return "as fontes elegíveis terminaram antes de preencher a duração planejada";
  }
  if (stats.podcastShortfallMs > 0) {
    return `a meta de ${stats.requestedPodcastPercent}% de podcast ficou em ${stats.actualPodcastPercent}% após aplicar fontes e limites por programa`;
  }
  if (stats.musicShortfallMs > 0) {
    return `a parcela de música ficou abaixo da regra; o plano terminou com ${stats.actualPodcastPercent}% de podcast`;
  }
  return `a composição desviou ${stats.mixDeviationPoints} pontos percentuais da regra`;
}

function dedupeByUri(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.uri)) continue;
    seen.add(c.uri);
    out.push(c);
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
