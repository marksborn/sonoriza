import type { RunStatus, RunTrigger, TargetPlaylist } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  computeCalendarDuration,
  type CalendarDurationResult,
} from "@/services/google-calendar";
import {
  parseSequencePattern,
  type RunTarget,
} from "@/services/playlist-planner";
import {
  isSpotifyApiError,
  SpotifyClient,
  type SpotifyApiErrorKind,
  type SpotifyRequestMetrics,
} from "@/services/spotify";
import {
  SpotifyIncrementalReader,
  type IncrementalSpotifySourceConfig,
  type SpotifyIncrementalCandidateSource,
} from "@/services/spotify/incremental-reader";

import {
  collectIncrementally,
  type IncrementalSourceBatch,
  type IncrementalPlanningRound,
} from "./incremental-planning";

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

type LogLine = {
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  data?: unknown;
};

type ResolvedTargetDuration = {
  durationMs: number;
  calendar: CalendarDurationResult | null;
  podcastEpisodeMaxDurationMs: number | null;
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

/**
 * End-to-end generation using demand-driven Spotify paging:
 *   1. resolve targets and their duration budgets;
 *   2. create read-only source cursors;
 *   3. read at most one provider page per needed source in each round;
 *   4. replan, requesting another page only for content kinds still short;
 *   5. stop immediately once every target passes quality;
 *   6. only then allow a real Spotify write.
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

  let writer: SpotifyClient | null = null;
  let reader: SpotifyIncrementalReader | null = null;

  try {
    // Resolve target demand before reading Spotify. This lets the collector skip
    // source kinds that no active target actually needs.
    const targets = await prisma.targetPlaylist.findMany({
      where: { userId, enabled: true },
      orderBy: { priority: "asc" },
    });
    const durationCalendarIds = (
      await prisma.calendarSelection.findMany({
        where: { userId, selected: true, usedForDuration: true },
      })
    ).map((calendar) => calendar.googleCalendarId);

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

      if (target.durationMode === "CALENDAR" && resolved.durationMs <= 0) {
        if (target.emptyCalendarBehavior === "CLEAR") {
          log({
            level: "INFO",
            message: `Target "${target.name}" has no eligible calendar events → will be cleared`,
          });
          runTargets.push(toRunTarget(target, 0, null));
        } else {
          log({
            level: "INFO",
            message: `Target "${target.name}" has no eligible calendar events → ${target.emptyCalendarBehavior} (untouched)`,
          });
          skipped.push(target);
        }
        continue;
      }

      runTargets.push(
        toRunTarget(
          target,
          resolved.durationMs,
          resolved.podcastEpisodeMaxDurationMs,
        ),
      );
    }

    const sources = (await prisma.sourcePlaylist.findMany({
      where: { userId, enabled: true },
    })) as IncrementalSpotifySourceConfig[];

    const authoritativePodcastProgramIds = new Set(
      sources
        .filter((source) => source.spotifyType === "SHOW")
        .map((source) => source.spotifyId),
    );

    reader = await SpotifyIncrementalReader.forUser(userId, {
      authoritativePodcastProgramIds,
    });
    const sourceCursors: SpotifyIncrementalCandidateSource[] = [];
    const setupFailures: SourceCollectionFailure[] = [];

    // Cursor creation is sequential by design. Podcast cursors are local-only;
    // music snapshot validation is also serialized to avoid a metadata burst.
    for (const source of sources) {
      try {
        sourceCursors.push(await reader.createSource(source));
      } catch (error) {
        setupFailures.push(sourceFailureFromConfig(source, error));
      }
    }

    if (setupFailures.length > 0) {
      summary.collectionComplete = false;
      summary.inconclusive = true;
      summary.inconclusiveReason = collectionFailureReason(setupFailures);
      summary.qualityPassed = false;
      summary.qualityFailures = [];
      summary.sourceCollection = {
        configuredSourceCount: sources.length,
        readSourceCount: 0,
        unavailableSourceCount: setupFailures.length,
        exhaustedSourceCount: 0,
        stoppedEarly: false,
        planningRounds: 0,
        failures: setupFailures,
      };
      summary.spotifyApi = reader.getRequestMetrics();

      const error = collectionFailureMessage(setupFailures, simulate);
      log({ level: "WARN", message: error, data: summary.sourceCollection });
      await finalizeRun(run.id, "FAILED", logs, summary, error);
      return { runId: run.id, status: "FAILED" };
    }

    let musicUnavailableSkippedCount = 0;
    let genericPodcastSuppressedCount = 0;
    const incremental = await collectIncrementally({
      sources: sourceCursors,
      targets: runTargets,
      onBatch(source, batch) {
        musicUnavailableSkippedCount += batch.unavailableMusicSkippedCount ?? 0;
        genericPodcastSuppressedCount += batch.genericPodcastSuppressedCount ?? 0;
        logIncrementalBatch(source, batch, log);
      },
      onRound(round) {
        logIncrementalRound(round, log);
      },
    });

    const readFailure = incremental.failure
      ? sourceFailureFromCursor(
          incremental.failure.source as SpotifyIncrementalCandidateSource,
          incremental.failure.error,
        )
      : null;
    const failures = readFailure ? [readFailure] : [];
    const exhaustedSourceCount = sourceCursors.filter((source) => source.done).length;

    summary.collectionComplete = failures.length === 0;
    summary.sourceCollection = {
      configuredSourceCount: sources.length,
      readSourceCount: incremental.readSourceIds.size,
      unavailableSourceCount: failures.length,
      exhaustedSourceCount,
      stoppedEarly: incremental.stoppedEarly,
      planningRounds: incremental.rounds,
      failures,
    };
    summary.incrementalCollection = {
      pageSize: 50,
      planningRounds: incremental.rounds,
      stoppedEarly: incremental.stoppedEarly,
      musicCandidatesRead: incremental.pools.music.length,
      podcastCandidatesRead: incremental.pools.podcasts.length,
    };
    summary.spotifyApi = reader.getRequestMetrics();
    summary.musicUnavailableSkippedCount = musicUnavailableSkippedCount;
    summary.genericPodcastSuppressedCount = genericPodcastSuppressedCount;

    if (readFailure) {
      summary.inconclusive = true;
      summary.inconclusiveReason = collectionFailureReason(failures);
      summary.qualityPassed = false;
      summary.qualityFailures = [];

      const error = collectionFailureMessage(failures, simulate);
      log({ level: "WARN", message: error, data: summary.sourceCollection });
      await finalizeRun(run.id, "FAILED", logs, summary, error);
      return { runId: run.id, status: "FAILED" };
    }

    const plan = incremental.plan;
    const qualityFailures = incremental.qualityFailures;
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
        message: `Target "${failure.name}" failed composition quality after incremental collection: ${qualityReason(failure.result.stats)}`,
      });
    }

    // A conclusive quality failure means every source kind that could improve
    // the failing plan was exhausted. Real generation still stops before any
    // Spotify write; simulation may persist the best plan for diagnosis.
    if (!simulate && qualityFailures.length > 0) {
      const error =
        "A geração foi bloqueada antes de alterar o Spotify porque, mesmo após buscar os lotes necessários, o plano não conseguiu atender às regras de composição configuradas.";
      await finalizeRun(run.id, "FAILED", logs, summary, error);
      return { runId: run.id, status: "FAILED" };
    }

    const targetByPlanId = new Map(targets.map((target) => [target.id, target]));
    const sequenceViolations = plan.targets.flatMap((planned) => {
      const target = targetByPlanId.get(planned.targetPlaylistId);
      if (!target || target.compositionMode !== "SEQUENCE") return [];
      const pattern = parseSequencePattern(target.sequencePattern);
      if (pattern.length === 0) {
        return [{ targetPlaylistId: target.id, targetName: target.name, reason: "INVALID_PATTERN" }];
      }
      const mismatch = planned.result.items.find(
        (item, index) => item.type !== pattern[index % pattern.length],
      );
      return mismatch
        ? [{ targetPlaylistId: target.id, targetName: target.name, reason: "TYPE_MISMATCH", position: mismatch.position }]
        : [];
    });

    if (!simulate && sequenceViolations.length > 0) {
      summary.sequenceViolations = sequenceViolations;
      const error =
        "A geração foi bloqueada antes de alterar o Spotify porque o plano divergiu da sequência configurada.";
      log({ level: "ERROR", message: error, data: sequenceViolations });
      await finalizeRun(run.id, "FAILED", logs, summary, error);
      return { runId: run.id, status: "FAILED" };
    }

    const podcastAuthorityViolations = plan.targets.flatMap((planned) =>
      planned.result.items
        .filter(
          (item) =>
            item.type === "PODCAST" &&
            Boolean(item.programId) &&
            authoritativePodcastProgramIds.has(item.programId!) &&
            item.sourceSpotifyType !== "SHOW",
        )
        .map((item) => ({
          targetPlaylistId: planned.targetPlaylistId,
          targetName: planned.name,
          uri: item.uri,
          programId: item.programId,
          sourceSpotifyType: item.sourceSpotifyType ?? null,
        })),
    );

    if (!simulate && podcastAuthorityViolations.length > 0) {
      summary.podcastAuthorityViolations = podcastAuthorityViolations;
      const error =
        "A geração foi bloqueada antes de alterar o Spotify porque um programa com fonte SHOW autoritativa recebeu candidato de uma fonte genérica.";
      log({ level: "ERROR", message: error, data: podcastAuthorityViolations });
      await finalizeRun(run.id, "FAILED", logs, summary, error);
      return { runId: run.id, status: "FAILED" };
    }

    // Defense in depth: revalidate selected podcasts against the
    // freshly resolved limit before a writer can even be created.
    const durationLimitViolations = plan.targets.flatMap((planned) => {
      const maxDurationMs =
        resolvedDurationByTargetId.get(planned.targetPlaylistId)
          ?.podcastEpisodeMaxDurationMs ?? null;
      if (maxDurationMs === null) return [];

      return planned.result.items
        .filter(
          (item) =>
            item.type === "PODCAST" &&
            Math.max(0, item.durationMs) > maxDurationMs,
        )
        .map((item) => ({
          targetPlaylistId: planned.targetPlaylistId,
          targetName: planned.name,
          uri: item.uri,
          durationMs: item.durationMs,
          maxDurationMs,
        }));
    });

    if (!simulate && durationLimitViolations.length > 0) {
      summary.podcastDurationLimitViolations = durationLimitViolations;
      const error =
        "A geração foi bloqueada antes de alterar o Spotify porque um podcast excedeu a duração máxima efetiva do destino.";
      log({ level: "ERROR", message: error, data: durationLimitViolations });
      await finalizeRun(run.id, "FAILED", logs, summary, error);
      return { runId: run.id, status: "FAILED" };
    }

    if (!simulate) writer = await SpotifyClient.forUser(userId);

    const targetById = new Map(targets.map((target) => [target.id, target]));
    let anyFailed = false;

    for (const planned of plan.targets) {
      const target = targetById.get(planned.targetPlaylistId)!;
      const { items, stats } = planned.result;
      const resolvedDuration = resolvedDurationByTargetId.get(target.id);
      const calendar = resolvedDuration?.calendar ?? null;
      const podcastEpisodeMaxDurationMs =
        resolvedDuration?.podcastEpisodeMaxDurationMs ?? null;

      const targetSummary: Record<string, unknown> = {
        name: target.name,
        planned: items.length,
        sequencePattern: parseSequencePattern(target.sequencePattern),
        ...stats,
        totalMinutes: Math.round(stats.totalDurationMs / 60_000),
        qualityReason: stats.compositionQualityPassed ? null : qualityReason(stats),
        podcastEpisodeMaxDurationMode: target.podcastEpisodeMaxDurationMode,
        podcastEpisodeMaxDurationMs,
        podcastEpisodeMaxDurationMinutes:
          podcastEpisodeMaxDurationMs === null
            ? null
            : Math.round(podcastEpisodeMaxDurationMs / 60_000),
        ...(calendar
          ? {
              calendarEventCount: calendar.matchedEvents,
              calendarTimedEventCount: calendar.timedEvents,
              calendarEventFilterMode: calendar.filterMode,
              calendarEventMarker: calendar.marker,
              calendarDurationMinutes: Math.round(calendar.durationMs / 60_000),
              calendarMaxEventDurationMinutes: Math.round(
                calendar.maxEventDurationMs / 60_000,
              ),
            }
          : {}),
      };

      try {
        if (!simulate) {
          const playlistId = await ensureSpotifyPlaylist(writer!, target);
          await writer!.replacePlaylistItems(
            playlistId,
            items.map((item) => item.uri),
          );
          targetSummary.applied = true;
        } else {
          targetSummary.applied = false;
        }

        await prisma.generationItem.createMany({
          data: items.map((item) => ({
            runId: run.id,
            targetPlaylistId: target.id,
            position: item.position,
            contentType: item.type,
            spotifyUri: item.uri,
            title: item.title,
            subtitle: item.subtitle,
            programId: item.programId,
            durationMs: item.durationMs,
          })),
        });

        log({
          level: "INFO",
          message: `Target "${target.name}": ${items.length} items, ${Math.round(
            stats.totalDurationMs / 60_000,
          )} min, ${stats.actualPodcastPercent}% podcast${simulate ? " (simulated)" : ""}`,
        });
      } catch (error) {
        anyFailed = true;
        targetSummary.error = errorMessage(error);
        log({
          level: "ERROR",
          message: `Failed to apply target "${target.name}": ${errorMessage(error)}`,
        });
      }

      (summary.targets as unknown[]).push(targetSummary);
    }

    summary.skipped = skipped.map((target) => target.name);
    summary.spotifyApi = mergeSpotifyMetrics(
      reader.getRequestMetrics(),
      writer?.getRequestMetrics() ?? null,
    );

    const status: RunStatus = anyFailed ? "PARTIAL" : "SUCCESS";
    await finalizeRun(run.id, status, logs, summary);
    return { runId: run.id, status };
  } catch (error) {
    summary.spotifyApi = mergeSpotifyMetrics(
      reader?.getRequestMetrics() ?? null,
      writer?.getRequestMetrics() ?? null,
    );
    log({ level: "ERROR", message: `Run failed: ${errorMessage(error)}` });
    await finalizeRun(run.id, "FAILED", logs, summary, errorMessage(error));
    return { runId: run.id, status: "FAILED" };
  }
}

function logIncrementalBatch(
  source: SpotifyIncrementalCandidateSource,
  batch: IncrementalSourceBatch,
  log: (line: LogLine) => void,
) {
  log({
    level: "INFO",
    message: `Source "${source.label}": ${batch.candidates.length} candidates read${batch.fromCache ? " from cache" : " in next batch"}${batch.done ? " (source exhausted)" : ""}`,
  });

  if ((batch.unavailableMusicSkippedCount ?? 0) > 0) {
    log({
      level: "INFO",
      message: `Music source "${source.label}": ${batch.unavailableMusicSkippedCount} unavailable Spotify tracks excluded`,
    });
  }

  if ((batch.fullyPlayedSkippedCount ?? 0) > 0) {
    log({
      level: "INFO",
      message: `Podcast source "${source.label}": ${batch.fullyPlayedSkippedCount} fully played episodes excluded`,
    });
  }
  if ((batch.playbackPositionMissingCount ?? 0) > 0) {
    log({
      level: "WARN",
      message: `Podcast source "${source.label}": Spotify omitted playback position for ${batch.playbackPositionMissingCount} episodes; full duration used for those items`,
    });
  }
}

function logIncrementalRound(
  round: IncrementalPlanningRound,
  log: (line: LogLine) => void,
) {
  log({
    level: "INFO",
    message: `Incremental planning round ${round.round}: requested ${round.requestedKinds.join("+") || "no additional source"}; pool=${round.musicCandidates} music/${round.podcastCandidates} podcast; quality=${round.qualityPassed ? "passed" : "needs more candidates"}`,
  });
}

function sourceFailureFromConfig(
  source: IncrementalSpotifySourceConfig,
  error: unknown,
): SourceCollectionFailure {
  const spotifyError = isSpotifyApiError(error) ? error : null;
  return {
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
}

function sourceFailureFromCursor(
  source: SpotifyIncrementalCandidateSource,
  error: unknown,
): SourceCollectionFailure {
  const spotifyError = isSpotifyApiError(error) ? error : null;
  return {
    source: source.label,
    kind: source.kind,
    spotifyType: source.spotifyType,
    spotifyId: source.spotifyId,
    errorKind: spotifyError?.kind ?? "SOURCE_READ_FAILED",
    status: spotifyError?.status ?? null,
    reason: spotifyError?.reason ?? null,
    operation: spotifyError?.operation ?? null,
    retryAfterSeconds: spotifyError?.retryAfterSeconds ?? null,
  };
}

async function resolveTargetDuration(
  userId: string,
  target: TargetPlaylist,
  durationCalendarIds: string[],
  date: Date,
  log: (line: LogLine) => void,
): Promise<ResolvedTargetDuration> {
  if (target.durationMode === "FIXED") {
    const podcastEpisodeMaxDurationMs = resolvePodcastEpisodeMaxDurationMs(
      target,
      null,
    );
    logPodcastEpisodeMaxDuration(target, podcastEpisodeMaxDurationMs, log);
    return {
      durationMs: (target.fixedDurationSeconds ?? 0) * 1000,
      calendar: null,
      podcastEpisodeMaxDurationMs,
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
    message: `Calendar duration for "${target.name}": ${calendar.matchedEvents}/${calendar.timedEvents} events (${filterDescription}), ${Math.round(calendar.durationMs / 60_000)} min total, largest ${Math.round(calendar.maxEventDurationMs / 60_000)} min`,
    data: {
      matchedEvents: calendar.matchedEvents,
      timedEvents: calendar.timedEvents,
      filterMode: calendar.filterMode,
      marker: calendar.marker,
      durationMs: calendar.durationMs,
      maxEventDurationMs: calendar.maxEventDurationMs,
    },
  });

  const podcastEpisodeMaxDurationMs = resolvePodcastEpisodeMaxDurationMs(
    target,
    calendar,
  );
  logPodcastEpisodeMaxDuration(target, podcastEpisodeMaxDurationMs, log);

  return {
    durationMs: calendar.durationMs,
    calendar,
    podcastEpisodeMaxDurationMs,
  };
}

function resolvePodcastEpisodeMaxDurationMs(
  target: TargetPlaylist,
  calendar: CalendarDurationResult | null,
): number | null {
  if (target.podcastEpisodeMaxDurationMode === "NONE") return null;

  if (target.podcastEpisodeMaxDurationMode === "FIXED") {
    const seconds = target.podcastEpisodeMaxDurationSeconds ?? 0;
    if (seconds <= 0) {
      throw new Error(
        `Target "${target.name}" has invalid fixed podcast episode duration`,
      );
    }
    return seconds * 1000;
  }

  if (target.durationMode !== "CALENDAR") {
    throw new Error(
      `Target "${target.name}" uses CALENDAR_MAX_EVENT outside CALENDAR duration mode`,
    );
  }

  if (!calendar || calendar.matchedEvents <= 0 || calendar.maxEventDurationMs <= 0) {
    return null;
  }

  return calendar.maxEventDurationMs;
}

function logPodcastEpisodeMaxDuration(
  target: TargetPlaylist,
  effectiveMaxDurationMs: number | null,
  log: (line: LogLine) => void,
) {
  const configured = target.podcastEpisodeMaxDurationMode;
  const effective =
    effectiveMaxDurationMs === null
      ? "no effective limit"
      : `${Math.round(effectiveMaxDurationMs / 60_000)} min`;

  log({
    level: "INFO",
    message: `Podcast episode duration for "${target.name}": ${configured} → ${effective}`,
    data: {
      mode: configured,
      configuredSeconds: target.podcastEpisodeMaxDurationSeconds,
      effectiveMaxDurationMs,
    },
  });
}

function toRunTarget(
  target: TargetPlaylist,
  durationMs: number,
  maxPodcastDurationMs: number | null,
): RunTarget {
  const sequencePattern = parseSequencePattern(target.sequencePattern);
  if (target.compositionMode === "SEQUENCE" && sequencePattern.length === 0) {
    throw new Error(`Target "${target.name}" has an invalid sequence composition`);
  }
  return {
    targetPlaylistId: target.id,
    name: target.name,
    priority: target.priority,
    rules: {
      targetDurationMs: durationMs,
      compositionMode: target.compositionMode,
      podcastPercent: target.podcastPercent,
      sequencePattern,
      maxEpisodesPerProgram: target.maxEpisodesPerProgram,
      maxPodcastDurationMs,
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
      data: logs.map((line) => ({
        runId,
        level: line.level,
        message: line.message,
        data: line.data === undefined ? undefined : (line.data as object),
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
        : "uma ou mais fontes do Spotify não puderam ser lidas até o ponto necessário para validar o plano";

  return `${prefix}: ${cause}. Nenhuma configuração foi considerada incorreta e nenhuma playlist do Spotify foi alterada.`;
}

function qualityReason(stats: {
  compositionMode: "PROPORTION" | "SEQUENCE";
  compositionQualityPassed: boolean;
  sequenceQualityPassed: boolean | null;
  sequenceUnfilledSlots: number;
  sequenceStopReason: string | null;
  requestedPodcastPercent: number;
  actualPodcastPercent: number;
  podcastShortfallMs: number;
  musicShortfallMs: number;
  poolExhausted: boolean;
  mixDeviationPoints: number;
}): string {
  if (stats.compositionMode === "SEQUENCE") {
    if (stats.sequenceQualityPassed === false) {
      return "a sequência configurada é inválida e não pode ser aplicada com segurança";
    }
    if (stats.sequenceUnfilledSlots > 0) {
      return `a sequência foi preservada, mas o próximo slot não pôde ser preenchido (${stats.sequenceStopReason ?? "sem candidato"})`;
    }
    return "a sequência configurada foi preservada";
  }
  if (stats.poolExhausted) {
    return "as fontes elegíveis terminaram antes de preencher a duração planejada";
  }
  if (stats.podcastShortfallMs > 0) {
    return `a meta de ${stats.requestedPodcastPercent}% de podcast ficou em ${stats.actualPodcastPercent}% após aplicar fontes, duração máxima e limites por programa`;
  }
  if (stats.musicShortfallMs > 0) {
    return `a parcela de música ficou abaixo da regra; o plano terminou com ${stats.actualPodcastPercent}% de podcast`;
  }
  return `a composição desviou ${stats.mixDeviationPoints} pontos percentuais da regra`;
}

function mergeSpotifyMetrics(
  left: SpotifyRequestMetrics | null,
  right: SpotifyRequestMetrics | null,
): SpotifyRequestMetrics | null {
  if (!left && !right) return null;
  const empty: SpotifyRequestMetrics = {
    totalCalls: 0,
    callsByOperation: {},
    rateLimitedCount: 0,
    quotaExceededCount: 0,
    retries: 0,
    retryWaitMs: 0,
    circuitOpenSkips: 0,
    cacheHits: 0,
    cacheMisses: 0,
    memoizedReadHits: 0,
    sourceReads: {},
  };
  const a = left ?? empty;
  const b = right ?? empty;
  const sourceKeys = new Set([
    ...Object.keys(a.sourceReads),
    ...Object.keys(b.sourceReads),
  ]);

  return {
    totalCalls: a.totalCalls + b.totalCalls,
    callsByOperation: mergeNumberRecords(a.callsByOperation, b.callsByOperation),
    rateLimitedCount: a.rateLimitedCount + b.rateLimitedCount,
    quotaExceededCount: a.quotaExceededCount + b.quotaExceededCount,
    retries: a.retries + b.retries,
    retryWaitMs: a.retryWaitMs + b.retryWaitMs,
    circuitOpenSkips: a.circuitOpenSkips + b.circuitOpenSkips,
    cacheHits: a.cacheHits + b.cacheHits,
    cacheMisses: a.cacheMisses + b.cacheMisses,
    memoizedReadHits: a.memoizedReadHits + b.memoizedReadHits,
    sourceReads: Object.fromEntries(
      [...sourceKeys].map((key) => {
        const x = a.sourceReads[key];
        const y = b.sourceReads[key];
        return [
          key,
          {
            pagesRead: (x?.pagesRead ?? 0) + (y?.pagesRead ?? 0),
            cacheHits: (x?.cacheHits ?? 0) + (y?.cacheHits ?? 0),
            cacheMisses: (x?.cacheMisses ?? 0) + (y?.cacheMisses ?? 0),
            snapshotUnchanged:
              (x?.snapshotUnchanged ?? 0) + (y?.snapshotUnchanged ?? 0),
            snapshotChanged:
              (x?.snapshotChanged ?? 0) + (y?.snapshotChanged ?? 0),
            memoizedHits: (x?.memoizedHits ?? 0) + (y?.memoizedHits ?? 0),
            cacheWrites: (x?.cacheWrites ?? 0) + (y?.cacheWrites ?? 0),
            cacheWriteFailures:
              (x?.cacheWriteFailures ?? 0) + (y?.cacheWriteFailures ?? 0),
          },
        ];
      }),
    ),
  };
}

function mergeNumberRecords(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const out = { ...left };
  for (const [key, value] of Object.entries(right)) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
