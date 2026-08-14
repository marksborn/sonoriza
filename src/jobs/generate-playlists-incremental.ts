import type { RunStatus, RunTrigger, TargetPlaylist } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  computeCalendarDuration,
  type CalendarDurationResult,
} from "@/services/google-calendar";
import {
  parseSequencePattern,
  type Candidate,
  type RunTarget,
} from "@/services/playlist-planner";
import type { KeepFilledTargetPatch } from "@/services/keep-filled-maintenance";
import {
  applyMusicOrder,
  createMusicOrderSeed,
  playlistOrderHash,
  type MusicOrderEvidence,
  type ReusableMusicOrderEvidence,
} from "@/services/playlist-ordering";
import {
  buildSourceCollectionDiagnosticSummary,
  safeConfiguredSourceLabel,
  type SourceCollectionFailureRecord,
} from "@/services/source-collection-diagnostics";
import {
  isSpotifyApiError,
  SpotifyClient,
  type SpotifyRequestMetrics,
} from "@/services/spotify";
import {
  SpotifyIncrementalReader,
  type IncrementalSpotifySourceConfig,
  type SpotifyIncrementalCandidateSource,
} from "@/services/spotify/incremental-reader";
import { checkPodcastCompletionBeforeWrite } from "@/services/spotify/podcast-authoritative-state";

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
  /** ORDER-01: one-shot seed/hash proof from a current approved simulation. */
  musicOrderSimulationEvidence?: Record<string, ReusableMusicOrderEvidence>;
  /** SCHEDULE-01: optional subset; omitted keeps manual generation behavior unchanged. */
  targetPlaylistIds?: string[];
  /** SCHEDULE-01: canonical valid remote prefix by target. */
  preservedByTargetId?: Record<string, Candidate[]>;
  /** SCHEDULE-01: minimal remote patch proof for KEEP_FILLED targets. */
  keepFilledByTargetId?: Record<string, KeepFilledTargetPatch>;
  /** SCHEDULE-01 audit label per scoped target. */
  scheduledPolicyByTargetId?: Record<string, "KEEP_FILLED" | "REBUILD_DAILY">;
  /** SCHEDULE-01: live URIs owned by enabled targets outside this scoped batch. */
  reservedUris?: string[];
  /** Snapshots proving the external reservation set is still current pre-write. */
  reservedTargetSnapshots?: Record<string, string>;
  /** Stable current state captured before a scheduled full rebuild. */
  rebuildByTargetId?: Record<
    string,
    { snapshotBefore: string; currentCount: number; currentDurationMs: number }
  >;
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

export type ResolvedTargetDuration = {
  durationMs: number;
  calendar: CalendarDurationResult | null;
  podcastEpisodeMaxDurationMs: number | null;
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
  const targetScope = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.filter(Boolean))]
    : null;
  const summary: Record<string, unknown> = {
    simulate,
    targetScope,
    scheduledPolicies: opts.scheduledPolicyByTargetId ?? null,
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
      where: {
        userId,
        enabled: true,
        ...(targetScope ? { id: { in: targetScope } } : {}),
      },
      orderBy: { priority: "asc" },
    });
    if (targetScope && targets.length !== targetScope.length) {
      throw new Error(
        "Um ou mais destinos agendados foram desabilitados ou removidos antes do planejamento.",
      );
    }
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
    const setupFailures: SourceCollectionFailureRecord[] = [];

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
      const spotifyMetrics = reader.getRequestMetrics();
      const sourceCollection = buildSourceCollectionDiagnosticSummary({
        sources,
        attemptedSourceIds: new Set(setupFailures.map((failure) => failure.sourceId)),
        readSourceIds: new Set(),
        failures: setupFailures,
        sourceReads: spotifyMetrics.sourceReads,
      });

      summary.collectionComplete = false;
      summary.inconclusive = true;
      summary.inconclusiveReason = collectionFailureReason(setupFailures);
      summary.qualityPassed = false;
      summary.qualityFailures = [];
      summary.sourceCollection = {
        ...sourceCollection,
        exhaustedSourceCount: 0,
        stoppedEarly: false,
        planningRounds: 0,
      };
      summary.spotifyApi = spotifyMetrics;

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
      preservedByTargetId: new Map(
        Object.entries(opts.preservedByTargetId ?? {}),
      ),
      initialReserved: opts.reservedUris ?? [],
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
    const spotifyMetrics = reader.getRequestMetrics();
    const sourceCollection = buildSourceCollectionDiagnosticSummary({
      sources,
      attemptedSourceIds: incremental.attemptedSourceIds,
      readSourceIds: incremental.readSourceIds,
      failures,
      sourceReads: spotifyMetrics.sourceReads,
    });

    summary.collectionComplete = failures.length === 0;
    summary.sourceCollection = {
      ...sourceCollection,
      exhaustedSourceCount,
      stoppedEarly: incremental.stoppedEarly,
      planningRounds: incremental.rounds,
    };
    summary.incrementalCollection = {
      pageSize: 50,
      planningRounds: incremental.rounds,
      stoppedEarly: incremental.stoppedEarly,
      musicCandidatesRead: incremental.pools.music.length,
      podcastCandidatesRead: incremental.pools.podcasts.length,
    };
    summary.spotifyApi = spotifyMetrics;
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
    const musicOrderEvidenceByTargetId = new Map<string, MusicOrderEvidence>();
    const musicOrderPreviewViolations: Array<{
      targetPlaylistId: string;
      targetName: string;
      expectedOrderHash: string;
      actualOrderHash: string;
    }> = [];

    for (const planned of plan.targets) {
      const target = targetByPlanId.get(planned.targetPlaylistId);
      if (!target) continue;

      const keepFilled = opts.keepFilledByTargetId?.[target.id] ?? null;
      const reusedEvidence = keepFilled
        ? null
        : opts.musicOrderSimulationEvidence?.[target.id] ?? null;
      const seed =
        target.musicOrderMode === "RANDOMIZED"
          ? reusedEvidence?.seed ?? createMusicOrderSeed(run.id, target.id)
          : null;
      const preservedUris = new Set(keepFilled?.preservedUris ?? []);
      const preservedPrefix: typeof planned.result.items = [];
      const orderableSuffix: typeof planned.result.items = [];
      let suffixStarted = false;
      for (const item of planned.result.items) {
        if (!suffixStarted && preservedUris.has(item.uri)) {
          preservedPrefix.push(item);
        } else {
          suffixStarted = true;
          orderableSuffix.push(item);
        }
      }
      const ordered = applyMusicOrder(
        keepFilled ? orderableSuffix : planned.result.items,
        target.musicOrderMode,
        seed,
        reusedEvidence ? "SIMULATION" : seed ? "RUN" : null,
      );
      if (keepFilled) {
        planned.result.items = [...preservedPrefix, ...ordered.items].map(
          (item, position) => ({ ...item, position }),
        );
        ordered.evidence.orderHash = playlistOrderHash(planned.result.items);
        ordered.evidence.musicCount = planned.result.items.filter(
          (item) => item.type === "MUSIC",
        ).length;
      } else {
        planned.result.items = ordered.items;
      }
      musicOrderEvidenceByTargetId.set(target.id, ordered.evidence);

      if (
        !keepFilled &&
        !simulate &&
        reusedEvidence &&
        ordered.evidence.orderHash !== reusedEvidence.orderHash
      ) {
        musicOrderPreviewViolations.push({
          targetPlaylistId: target.id,
          targetName: target.name,
          expectedOrderHash: reusedEvidence.orderHash,
          actualOrderHash: ordered.evidence.orderHash,
        });
      }
    }

    if (musicOrderPreviewViolations.length > 0) {
      summary.musicOrderPreviewViolations = musicOrderPreviewViolations;
      const error =
        "A geração foi bloqueada antes de alterar o Spotify porque a ordem final mudou desde a simulação aprovada. Simule novamente antes de publicar.";
      log({ level: "ERROR", message: error, data: musicOrderPreviewViolations });
      await finalizeRun(run.id, "FAILED", logs, summary, error);
      return { runId: run.id, status: "FAILED" };
    }

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


    if (!simulate) {
      const liveTargets = await prisma.targetPlaylist.findMany({
        where: {
          userId,
          enabled: true,
          ...(targetScope ? { id: { in: targetScope } } : {}),
        },
        select: {
          id: true,
          name: true,
          maxTracksPerArtist: true,
          maxTracksPerAlbum: true,
        },
      });
      const originalTargetById = new Map(targets.map((target) => [target.id, target]));
      const liveTargetById = new Map(liveTargets.map((target) => [target.id, target]));
      const musicDiversityConfigurationChanges: Array<{
        targetPlaylistId: string;
        targetName: string;
        reason: string;
      }> = [];

      for (const target of targets) {
        const live = liveTargetById.get(target.id);
        if (!live) {
          musicDiversityConfigurationChanges.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            reason: "TARGET_DISABLED_OR_REMOVED",
          });
          continue;
        }
        if (
          live.maxTracksPerArtist !== target.maxTracksPerArtist ||
          live.maxTracksPerAlbum !== target.maxTracksPerAlbum
        ) {
          musicDiversityConfigurationChanges.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            reason: "DIVERSITY_LIMIT_CHANGED",
          });
        }
      }
      for (const live of liveTargets) {
        if (!originalTargetById.has(live.id)) {
          musicDiversityConfigurationChanges.push({
            targetPlaylistId: live.id,
            targetName: live.name,
            reason: "TARGET_ENABLED_DURING_RUN",
          });
        }
      }

      if (musicDiversityConfigurationChanges.length > 0) {
        summary.musicDiversityConfigurationChanges =
          musicDiversityConfigurationChanges;
        const error =
          "A geração foi bloqueada antes de alterar o Spotify porque a configuração de diversidade mudou desde o início do planejamento. Simule novamente antes de publicar.";
        log({
          level: "ERROR",
          message: error,
          data: musicDiversityConfigurationChanges,
        });
        await finalizeRun(run.id, "FAILED", logs, summary, error);
        return { runId: run.id, status: "FAILED" };
      }

      const musicDiversityViolations = plan.targets.flatMap((planned) => {
        const live = liveTargetById.get(planned.targetPlaylistId);
        if (!live) return [];
        return validatePlannedMusicDiversity(
          planned.targetPlaylistId,
          planned.name,
          planned.result.items,
          live.maxTracksPerArtist,
          live.maxTracksPerAlbum,
        );
      });

      if (musicDiversityViolations.length > 0) {
        summary.musicDiversityViolations = musicDiversityViolations;
        const error =
          "A geração foi bloqueada antes de alterar o Spotify porque o plano final violou a diversidade configurada. Simule novamente antes de publicar.";
        log({ level: "ERROR", message: error, data: musicDiversityViolations });
        await finalizeRun(run.id, "FAILED", logs, summary, error);
        return { runId: run.id, status: "FAILED" };
      }
    }

    if (!simulate) writer = await SpotifyClient.forUser(userId);

    if (!simulate && writer) {
      const reservationSnapshotViolations: Array<{
        spotifyPlaylistId: string;
        expected: string;
        actual: string;
      }> = [];
      for (const [spotifyPlaylistId, expected] of Object.entries(
        opts.reservedTargetSnapshots ?? {},
      )) {
        const actual = await writer.getPlaylistSnapshotId(spotifyPlaylistId);
        if (actual !== expected) {
          reservationSnapshotViolations.push({ spotifyPlaylistId, expected, actual });
        }
      }
      if (reservationSnapshotViolations.length > 0) {
        summary.externalReservationSnapshotViolations =
          reservationSnapshotViolations;
        const error =
          "A geração agendada foi bloqueada antes de alterar o Spotify porque outro destino mudou depois de reservar sua exclusividade.";
        log({ level: "ERROR", message: error, data: reservationSnapshotViolations });
        await finalizeRun(run.id, "FAILED", logs, summary, error);
        return { runId: run.id, status: "FAILED" };
      }

      const snapshotViolations: Array<{
        targetPlaylistId: string;
        targetName: string;
        expected: string;
        actual: string | null;
      }> = [];
      for (const target of targets) {
        const patch = opts.keepFilledByTargetId?.[target.id];
        const rebuild = opts.rebuildByTargetId?.[target.id];
        const expected = patch?.snapshotBefore ?? rebuild?.snapshotBefore ?? null;
        if (!expected) continue;
        if (!target.spotifyPlaylistId) {
          snapshotViolations.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            expected,
            actual: null,
          });
          continue;
        }
        const actual = await writer.getPlaylistSnapshotId(target.spotifyPlaylistId);
        if (actual !== expected) {
          snapshotViolations.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            expected,
            actual,
          });
        }
      }
      if (snapshotViolations.length > 0) {
        summary.scheduledTargetSnapshotViolations = snapshotViolations;
        const error =
          "A manutenção foi bloqueada antes de alterar o Spotify porque um destino mudou depois da leitura canônica. Tente novamente no próximo ciclo.";
        log({ level: "ERROR", message: error, data: snapshotViolations });
        await finalizeRun(run.id, "FAILED", logs, summary, error);
        return { runId: run.id, status: "FAILED" };
      }
    }

    // SCHEDULE-03 / PODCAST-04 defense in depth: source collection and
    // KEEP_FILLED preparation can become stale while a run is planning.
    // Immediately before any Spotify write, re-read every selected podcast
    // that does not explicitly allow replay through GET /episodes/{id}.
    if (!simulate) {
      let podcastPrewrite;

      try {
        podcastPrewrite = await checkPodcastCompletionBeforeWrite(
          userId,
          plan.targets.map((planned) => ({
            targetPlaylistId: planned.targetPlaylistId,
            targetName: planned.name,
            items: planned.result.items,
          })),
          new Date(),
          // P2: route the authoritative episode reads through the run's
          // instrumented client so they are counted in summary.spotifyApi.
          { episodeReader: (episodeId) => writer!.getEpisodePlaybackState(episodeId) },
        );
      } catch (error) {
        const providerError = errorMessage(error);

        summary.podcastPrewriteRevalidation = {
          status: "FAILED",
          error: providerError,
        };

        const message =
          `A geração foi bloqueada antes de alterar o Spotify porque não foi possível ` +
          `revalidar o estado final dos podcasts: ${providerError}`;

        log({
          level: "ERROR",
          message,
        });

        await finalizeRun(run.id, "FAILED", logs, summary, message);
        return { runId: run.id, status: "FAILED" };
      }

      summary.podcastPrewriteRevalidation = {
        status:
          podcastPrewrite.violations.length === 0 ? "PASSED" : "BLOCKED",
        checkedEpisodeCount: podcastPrewrite.checkedEpisodeIds.length,
        checkedEpisodeIds: podcastPrewrite.checkedEpisodeIds,
        violations: podcastPrewrite.violations,
      };

      if (podcastPrewrite.violations.length > 0) {
        const error =
          "A geração foi bloqueada antes de alterar o Spotify porque um ou mais " +
          "podcasts sem replay explícito ficaram concluídos ou não puderam ser " +
          "validados após o planejamento. O próximo ciclo deverá planejar novamente.";

        log({
          level: "ERROR",
          message: error,
          data: podcastPrewrite.violations,
        });

        await finalizeRun(run.id, "FAILED", logs, summary, error);
        return { runId: run.id, status: "FAILED" };
      }
    }

    const targetById = new Map(targets.map((target) => [target.id, target]));
    let anyFailed = false;

    for (const planned of plan.targets) {
      const target = targetById.get(planned.targetPlaylistId)!;
      const { items, stats } = planned.result;
      const resolvedDuration = resolvedDurationByTargetId.get(target.id);
      const calendar = resolvedDuration?.calendar ?? null;
      const podcastEpisodeMaxDurationMs =
        resolvedDuration?.podcastEpisodeMaxDurationMs ?? null;
      const musicOrderEvidence = musicOrderEvidenceByTargetId.get(target.id) ?? null;

      const targetSummary: Record<string, unknown> = {
        targetPlaylistId: target.id,
        name: target.name,
        planned: items.length,
        musicOrderMode: target.musicOrderMode,
        musicOrderSeed: musicOrderEvidence?.seed ?? null,
        musicOrderSeedSource: musicOrderEvidence?.seedSource ?? null,
        musicOrderHash: musicOrderEvidence?.orderHash ?? null,
        musicOrderChanged: musicOrderEvidence?.changed ?? false,
        maxTracksPerArtist: target.maxTracksPerArtist,
        maxTracksPerAlbum: target.maxTracksPerAlbum,
        scheduledPolicy: opts.scheduledPolicyByTargetId?.[target.id] ?? null,
        targetDurationMs: resolvedDuration?.durationMs ?? 0,
        sequencePattern: parseSequencePattern(target.sequencePattern),
        ...stats,
        musicCount: items.filter((item) => item.type === "MUSIC").length,
        podcastCount: items.filter((item) => item.type === "PODCAST").length,
        musicDurationMs: items
          .filter((item) => item.type === "MUSIC")
          .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0),
        podcastDurationMs: items
          .filter((item) => item.type === "PODCAST")
          .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0),
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
          const patch = opts.keepFilledByTargetId?.[target.id] ?? null;
          if (!patch) {
            const rebuild = opts.rebuildByTargetId?.[target.id] ?? null;
            if (rebuild) {
              const currentSnapshot = await writer!.getPlaylistSnapshotId(playlistId);
              if (currentSnapshot !== rebuild.snapshotBefore) {
                throw new Error(
                  `Target "${target.name}" changed after its final rebuild preflight`,
                );
              }
            }
            const snapshotAfter = await writer!.replacePlaylistItems(
              playlistId,
              items.map((item) => item.uri),
            );
            targetSummary.applied = true;
            targetSummary.snapshotAfter = snapshotAfter;
            if (rebuild) {
              targetSummary.snapshotBefore = rebuild.snapshotBefore;
              targetSummary.validDurationBeforeMs = null;
              targetSummary.removedDurationMs = rebuild.currentDurationMs;
              targetSummary.addedDurationMs = stats.totalDurationMs;
              targetSummary.preservedCount = 0;
              targetSummary.removedCount = rebuild.currentCount;
              targetSummary.addedCount = items.length;
              targetSummary.addedMusicCount = items.filter(
                (item) => item.type === "MUSIC",
              ).length;
              targetSummary.addedPodcastCount = items.filter(
                (item) => item.type === "PODCAST",
              ).length;
              targetSummary.addedMusicDurationMs = items
                .filter((item) => item.type === "MUSIC")
                .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
              targetSummary.addedPodcastDurationMs = items
                .filter((item) => item.type === "PODCAST")
                .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
              targetSummary.maintenanceNoop = false;
            }
          } else {
            const currentSnapshot = await writer!.getPlaylistSnapshotId(playlistId);
            if (currentSnapshot !== patch.snapshotBefore) {
              throw new Error(
                `Target "${target.name}" changed after its final maintenance preflight`,
              );
            }

            const finalUris = items.map((item) => item.uri);
            const finalUriSet = new Set(finalUris);
            const preservedUriSet = new Set(patch.preservedUris);
            const addedItems = items.filter((item) => !preservedUriSet.has(item.uri));
            const addedUris = addedItems.map((item) => item.uri);
            const addedUriSet = new Set(addedUris);
            const droppedPreservedUris = patch.preservedUris.filter(
              (uri) => !finalUriSet.has(uri),
            );
            const effectiveRemoveUris = [
              ...new Set([...patch.removeUris, ...droppedPreservedUris]),
            ];
            const forceReplace =
              patch.forceReplace ||
              effectiveRemoveUris.some((uri) => addedUriSet.has(uri));
            const preservedCandidates = opts.preservedByTargetId?.[target.id] ?? [];
            const droppedDurationMs = preservedCandidates
              .filter((item) => droppedPreservedUris.includes(item.uri))
              .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
            const addedDurationMs = addedItems.reduce(
              (sum, item) => sum + Math.max(0, item.durationMs),
              0,
            );

            let snapshotAfter: string | null = currentSnapshot;
            let applied = false;
            if (forceReplace) {
              snapshotAfter = await writer!.replacePlaylistItems(playlistId, finalUris);
              applied = true;
            } else {
              if (addedUris.length > 0) {
                snapshotAfter =
                  (await writer!.appendPlaylistItems(playlistId, addedUris)) ??
                  snapshotAfter;
                applied = true;
              }
              if (effectiveRemoveUris.length > 0) {
                snapshotAfter =
                  (await writer!.removePlaylistItems(
                    playlistId,
                    effectiveRemoveUris,
                    snapshotAfter ?? currentSnapshot,
                  )) ?? snapshotAfter;
                applied = true;
              }
            }

            targetSummary.applied = applied;
            targetSummary.maintenanceNoop = !applied;
            targetSummary.targetDurationMs = patch.targetDurationMs;
            targetSummary.validDurationBeforeMs = patch.validDurationBeforeMs;
            targetSummary.removedDurationMs =
              patch.removedDurationMs + droppedDurationMs;
            targetSummary.addedDurationMs = addedDurationMs;
            targetSummary.preservedCount = items.length - addedItems.length;
            targetSummary.removedCount =
              patch.removedCount + droppedPreservedUris.length;
            targetSummary.addedCount = addedItems.length;
            targetSummary.addedMusicCount = addedItems.filter(
              (item) => item.type === "MUSIC",
            ).length;
            targetSummary.addedPodcastCount = addedItems.filter(
              (item) => item.type === "PODCAST",
            ).length;
            targetSummary.addedMusicDurationMs = addedItems
              .filter((item) => item.type === "MUSIC")
              .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
            targetSummary.addedPodcastDurationMs = addedItems
              .filter((item) => item.type === "PODCAST")
              .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
            targetSummary.unknownReplayPolicyCount = patch.unknownReplayPolicyCount;
            targetSummary.snapshotBefore = patch.snapshotBefore;
            targetSummary.snapshotAfter = snapshotAfter;
            targetSummary.minimalPatch = !forceReplace;
            targetSummary.droppedPreservedCount = droppedPreservedUris.length;
          }
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
            spotifyTrackId: item.spotifyTrackId,
            primaryArtistId: item.primaryArtistId,
            albumId: item.albumId,
            originalDurationMs: item.originalDurationMs,
            resumePositionMs: item.resumePositionMs,
            sourceSpotifyType: item.sourceSpotifyType,
            sourceSpotifyId: item.sourceSpotifyId,
            sourceIncludePlayed: item.sourceIncludePlayed,
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
): SourceCollectionFailureRecord {
  const spotifyError = isSpotifyApiError(error) ? error : null;
  return {
    sourceId: source.id,
    source: safeConfiguredSourceLabel(source),
    kind: source.kind,
    spotifyType: source.spotifyType,
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
): SourceCollectionFailureRecord {
  const spotifyError = isSpotifyApiError(error) ? error : null;
  return {
    sourceId: source.id,
    source: source.label,
    kind: source.kind,
    spotifyType: source.spotifyType,
    errorKind: spotifyError?.kind ?? "SOURCE_READ_FAILED",
    status: spotifyError?.status ?? null,
    reason: spotifyError?.reason ?? null,
    operation: spotifyError?.operation ?? null,
    retryAfterSeconds: spotifyError?.retryAfterSeconds ?? null,
  };
}

export async function resolveTargetDuration(
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
      maxTracksPerArtist: target.maxTracksPerArtist,
      maxTracksPerAlbum: target.maxTracksPerAlbum,
    },
  };
}


type MusicDiversityViolation = {
  targetPlaylistId: string;
  targetName: string;
  uri: string;
  rule: "MISSING_ARTIST_ID" | "MISSING_ALBUM_ID" | "ARTIST_LIMIT" | "ALBUM_LIMIT";
  identity: string | null;
  limit: number | null;
};

function validatePlannedMusicDiversity(
  targetPlaylistId: string,
  targetName: string,
  items: Array<{
    type: "MUSIC" | "PODCAST";
    uri: string;
    primaryArtistId?: string;
    albumId?: string;
  }>,
  maxTracksPerArtist: number | null,
  maxTracksPerAlbum: number | null,
): MusicDiversityViolation[] {
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const violations: MusicDiversityViolation[] = [];

  for (const item of items) {
    if (item.type !== "MUSIC") continue;

    const artistId = item.primaryArtistId?.trim() || null;
    const albumId = item.albumId?.trim() || null;

    if (maxTracksPerArtist !== null) {
      if (!artistId) {
        violations.push({
          targetPlaylistId,
          targetName,
          uri: item.uri,
          rule: "MISSING_ARTIST_ID",
          identity: null,
          limit: maxTracksPerArtist,
        });
      } else {
        const next = (artistCounts.get(artistId) ?? 0) + 1;
        artistCounts.set(artistId, next);
        if (next > maxTracksPerArtist) {
          violations.push({
            targetPlaylistId,
            targetName,
            uri: item.uri,
            rule: "ARTIST_LIMIT",
            identity: artistId,
            limit: maxTracksPerArtist,
          });
        }
      }
    }

    if (maxTracksPerAlbum !== null) {
      if (!albumId) {
        violations.push({
          targetPlaylistId,
          targetName,
          uri: item.uri,
          rule: "MISSING_ALBUM_ID",
          identity: null,
          limit: maxTracksPerAlbum,
        });
      } else {
        const next = (albumCounts.get(albumId) ?? 0) + 1;
        albumCounts.set(albumId, next);
        if (next > maxTracksPerAlbum) {
          violations.push({
            targetPlaylistId,
            targetName,
            uri: item.uri,
            rule: "ALBUM_LIMIT",
            identity: albumId,
            limit: maxTracksPerAlbum,
          });
        }
      }
    }
  }

  return violations;
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
  failures: SourceCollectionFailureRecord[],
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
  failures: SourceCollectionFailureRecord[],
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
  artistLimitRejectedCount: number;
  albumLimitRejectedCount: number;
  missingArtistIdentityRejectedCount: number;
  missingAlbumIdentityRejectedCount: number;
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
    const diversityRejected =
      stats.artistLimitRejectedCount +
      stats.albumLimitRejectedCount +
      stats.missingArtistIdentityRejectedCount +
      stats.missingAlbumIdentityRejectedCount;
    return diversityRejected > 0
      ? `o pool elegível terminou antes de preencher a duração após ${diversityRejected} rejeições de diversidade musical`
      : "as fontes elegíveis terminaram antes de preencher a duração planejada";
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
