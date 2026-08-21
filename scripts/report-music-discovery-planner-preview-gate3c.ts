import type { TargetPlaylist } from "@prisma/client";

import { resolveTargetDuration } from "@/jobs/generate-playlists-incremental";
import { prisma } from "@/lib/prisma";
import { calendarDurationPlanningBlocks } from "@/services/calendar-duration-strategy";
import { getCompleteMusicDiscoveryProfile } from "@/services/music-discovery/complete-profile";
import {
  buildGate3CHybridPlannerPreview,
  collectCompleteDiscoveryMusicUniverse,
} from "@/services/music-discovery/planner-preview-gate3c";
import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";
import { loadPendingInferredSkips } from "@/services/music-preference";
import {
  parseSequencePattern,
  type Candidate,
  type DurationPlanningBlock,
  type RunTarget,
} from "@/services/playlist-planner";
import {
  filterMusicCandidatesForRepeat,
  loadMusicRepeatContext,
} from "@/services/spotify/recently-played";
import {
  SpotifyIncrementalReader,
  type IncrementalSpotifySourceConfig,
} from "@/services/spotify/incremental-reader";

type Args = {
  email: string;
  targetId: string | null;
  asOf: Date;
  rediscoveryCeiling: number | undefined;
  json: boolean;
};

type RequestMetricsSnapshot = ReturnType<SpotifyIncrementalReader["getRequestMetrics"]>;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const targets = await prisma.targetPlaylist.findMany({
    where: {
      userId: user.id,
      enabled: true,
      ...(args.targetId ? { id: args.targetId } : {}),
    },
    orderBy: { priority: "asc" },
  });
  if (args.targetId && targets.length === 0) {
    throw new Error(`Enabled target not found: ${args.targetId}`);
  }
  if (targets.length === 0) throw new Error("No enabled target playlists found");

  const durationCalendarIds = (
    await prisma.calendarSelection.findMany({
      where: { userId: user.id, selected: true, usedForDuration: true },
    })
  ).map((calendar) => calendar.googleCalendarId);

  const runTargets: RunTarget[] = [];
  const skippedTargets: Array<{ id: string; name: string; reason: string }> = [];
  for (const target of targets) {
    const resolved = await resolveTargetDuration(
      user.id,
      target,
      durationCalendarIds,
      args.asOf,
      () => undefined,
    );
    const durationBlocks = calendarDurationPlanningBlocks(
      target.calendarDurationStrategy,
      resolved.calendar,
    );

    if (
      target.durationMode === "CALENDAR" &&
      resolved.durationMs <= 0 &&
      target.emptyCalendarBehavior !== "CLEAR"
    ) {
      skippedTargets.push({
        id: target.id,
        name: target.name,
        reason: `empty calendar -> ${target.emptyCalendarBehavior}`,
      });
      continue;
    }

    runTargets.push(
      toRunTarget(
        target,
        resolved.durationMs,
        resolved.podcastEpisodeMaxDurationMs,
        durationBlocks,
      ),
    );
  }
  if (runTargets.length === 0) {
    throw new Error("Every enabled target was skipped by its empty-calendar policy");
  }

  const sourceConfigs = (await prisma.sourcePlaylist.findMany({
    where: { userId: user.id, enabled: true },
  })) as IncrementalSpotifySourceConfig[];
  const authoritativePodcastProgramIds = new Set(
    sourceConfigs
      .filter((source) => source.spotifyType === "SHOW")
      .map((source) => source.spotifyId),
  );
  const reader = await SpotifyIncrementalReader.forUser(user.id, {
    authoritativePodcastProgramIds,
  });
  const cursors = [];
  for (const source of sourceConfigs) cursors.push(await reader.createSource(source));

  const [musicUniverseRaw, completeProfile, trackIdentities, repeatContext] =
    await Promise.all([
      collectCompleteDiscoveryMusicUniverse(cursors),
      getCompleteMusicDiscoveryProfile(user.id, { asOf: args.asOf }),
      getDiscoveryTrackIdentityEvidence(user.id),
      loadMusicRepeatContext(user.id, args.asOf),
    ]);
  const metricsAfterCompleteMusic = reader.getRequestMetrics();

  // Gate 3C still does not sync Recently Played. It uses persisted MUSIC-01
  // state plus Gate 1.1's reconciled timeline before ranking the complete MUSIC
  // universe. The incremental planner later receives only already-safe music.
  const repeatFiltered = filterMusicCandidatesForRepeat(
    musicUniverseRaw.sourceUniverse.music,
    repeatContext,
  );
  const profileCooldownByTrackId = new Map(
    completeProfile.tracks.map((track) => [
      track.spotifyTrackId,
      track.cooldownEligible,
    ] as const),
  );
  let profileCooldownBlockedCount = 0;
  const safeMusic = repeatFiltered.candidates.filter((candidate) => {
    const trackId = candidate.spotifyTrackId;
    if (!trackId) return true;
    const eligible = profileCooldownByTrackId.get(trackId);
    if (eligible === false || eligible === null) {
      profileCooldownBlockedCount += 1;
      return false;
    }
    return true;
  });
  const musicUniverse = {
    ...musicUniverseRaw,
    sourceUniverse: {
      ...musicUniverseRaw.sourceUniverse,
      music: safeMusic,
    },
  };

  const pendingSignals = await loadPendingInferredSkips(
    user.id,
    runTargets.map((target) => target.targetPlaylistId),
  );
  const blockedMusicTrackIdsByTargetId = new Map<string, ReadonlySet<string>>();
  for (const [targetId, signals] of pendingSignals) {
    if (signals.length === 0) continue;
    blockedMusicTrackIdsByTargetId.set(
      targetId,
      new Set(signals.map((signal) => signal.spotifyTrackId)),
    );
  }

  const podcastSources = cursors.filter((source) => source.kind === "PODCAST");
  const preview = await buildGate3CHybridPlannerPreview({
    profile: completeProfile,
    musicUniverse,
    trackIdentities,
    targets: runTargets,
    podcastSources,
    blockedMusicTrackIdsByTargetId,
    rediscoveryCeiling: args.rediscoveryCeiling,
  });
  const spotifyApi = reader.getRequestMetrics();
  const podcastApiDelta = requestMetricsDelta(
    metricsAfterCompleteMusic,
    spotifyApi,
  );
  const targetById = new Map(
    runTargets.map((target) => [target.targetPlaylistId, target] as const),
  );

  const payload = {
    user: user.email ?? user.id,
    generatedAt: args.asOf,
    version: preview.version,
    selectionMode: preview.selectionMode,
    writePolicy: {
      spotifyPlaylistWrites: false,
      historyWrites: false,
      preferenceSignalWrites: false,
      note:
        "Gate 3C exhausts MUSIC sources only. PODCAST sources keep incremental early-stop semantics. Existing source cache / observed podcast state may refresh while reading; no target playlist is written.",
    },
    targetScope: args.targetId,
    skippedTargets,
    completeUniverse: {
      historyArtists: preview.selection.evidence.historyArtistCount,
      historyTracks: preview.selection.evidence.historyTrackCount,
      musicSourceCount: musicUniverseRaw.sourceUniverse.evidence.musicSourceCount,
      podcastSourceCount: podcastSources.length,
      sourceMusicBeforeCooldown: musicUniverseRaw.sourceUniverse.music.length,
      sourceMusicAfterCooldown: safeMusic.length,
      musicSourceReadCalls: musicUniverseRaw.sourceUniverse.evidence.readCalls,
      everyMusicSourceDone: musicUniverseRaw.sourceUniverse.evidence.sources.every(
        (source) => source.done,
      ),
      podcastSourcesIntentionallyNotRequiredComplete: true,
      selectionReady: preview.selection.scoring.selectionPolicy.selectionReady,
    },
    music01: {
      enabled: repeatContext.enabled,
      cutoff: repeatContext.cutoff,
      persistedStateBlockedCount: repeatFiltered.recentlyPlayedSkippedCount,
      missingIdentityBlockedCount: repeatFiltered.missingTrackIdentitySkippedCount,
      reconciledTimelineBlockedCount: profileCooldownBlockedCount,
    },
    music05: {
      targetsWithPendingSignals: blockedMusicTrackIdsByTargetId.size,
      pendingSignalCount: [...pendingSignals.values()].reduce(
        (sum, signals) => sum + signals.length,
        0,
      ),
    },
    scoring: {
      version: preview.selection.scoring.version,
      candidateUniverse: preview.selection.scoring.selectionPolicy.candidateUniverse,
      selectionReady: preview.selection.scoring.selectionPolicy.selectionReady,
      categoryBudgetRule:
        preview.selection.scoring.selectionPolicy.categoryBudgetRule,
    },
    bridge: preview.selection.plannerPool.evidence,
    musicSourceCollection: musicUniverseRaw.sourceUniverse.evidence,
    podcastIncremental: {
      ...preview.podcastEvidence,
      rounds: preview.incremental.rounds,
      plannerStoppedEarly: preview.incremental.stoppedEarly,
      failure: preview.incremental.failure
        ? {
            sourceId: preview.incremental.failure.source.id,
            message:
              preview.incremental.failure.error instanceof Error
                ? preview.incremental.failure.error.message
                : String(preview.incremental.failure.error),
          }
        : null,
    },
    spotifyApi: {
      total: spotifyApi,
      completeMusicPhase: metricsAfterCompleteMusic,
      podcastIncrementalDelta: podcastApiDelta,
    },
    targets: preview.incremental.plan.targets.map((target) => {
      const config = targetById.get(target.targetPlaylistId);
      const targetDurationMs = config?.rules.targetDurationMs ?? 0;
      const durationDeficitMs = Math.max(
        0,
        targetDurationMs - target.result.stats.totalDurationMs,
      );
      const durationOverageMs = Math.max(
        0,
        target.result.stats.totalDurationMs - targetDurationMs,
      );
      return {
        targetPlaylistId: target.targetPlaylistId,
        name: target.name,
        compositionMode: target.result.stats.compositionMode,
        qualityPassed: target.result.stats.compositionQualityPassed,
        targetDurationMs,
        totalDurationMs: target.result.stats.totalDurationMs,
        durationDeficitMs,
        durationDeficitSeconds: round3(durationDeficitMs / 1_000),
        durationOverageMs,
        underTarget: durationDeficitMs > 0,
        legacyPoolExhaustedFlag: target.result.stats.poolExhausted,
        musicDurationMs: target.result.stats.musicDurationMs,
        podcastDurationMs: target.result.stats.podcastDurationMs,
        musicCount: target.result.stats.musicCount,
        podcastCount: target.result.stats.podcastCount,
        requestedPodcastPercent: target.result.stats.requestedPodcastPercent,
        actualPodcastPercent: target.result.stats.actualPodcastPercent,
        mixDeviationPoints: target.result.stats.mixDeviationPoints,
        sequenceStopReason: target.result.stats.sequenceStopReason,
        stoppedAtPatternIndex: target.result.stats.stoppedAtPatternIndex,
        segmentationDeficitMs: target.result.stats.segmentation?.deficitMs ?? 0,
        items: target.result.items.map((item) =>
          itemEvidence(item, preview.selection.plannerPool.entries),
        ),
      };
    }),
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 3C HYBRID PLANNER PREVIEW ==========");
  console.log(`User:                  ${payload.user}`);
  console.log(`As of:                 ${args.asOf.toISOString()}`);
  console.log(
    `History universe:      ${payload.completeUniverse.historyArtists} artists / ${payload.completeUniverse.historyTracks} tracks`,
  );
  console.log(
    `MUSIC universe:        ${payload.completeUniverse.sourceMusicBeforeCooldown} before cooldown / ${payload.completeUniverse.sourceMusicAfterCooldown} eligible`,
  );
  console.log(
    `MUSIC sources done:    ${payload.completeUniverse.everyMusicSourceDone} (${payload.completeUniverse.musicSourceReadCalls} reads)`,
  );
  console.log(
    `PODCAST incremental:   ${payload.podcastIncremental.readCalls} reads; ${payload.podcastIncremental.remainingSourceCount} cursors left open`,
  );
  console.log(
    `Spotify calls:         MUSIC phase=${payload.spotifyApi.completeMusicPhase.totalCalls}; PODCAST incremental=${payload.spotifyApi.podcastIncrementalDelta.totalCalls}; total=${payload.spotifyApi.total.totalCalls}`,
  );
  console.log(`Selection ready:       ${payload.completeUniverse.selectionReady}`);
  console.log(
    `Rediscovery ceiling:   ${preview.selection.plannerPool.evidence.rediscoveryCeiling}`,
  );
  console.log("Playlist writes:       NONE (preview only)");

  for (const target of payload.targets) {
    console.log(
      `\n[${target.name}] quality=${target.qualityPassed} target=${minutes(target.targetDurationMs)} min total=${minutes(target.totalDurationMs)} min deficit=${target.durationDeficitSeconds}s music=${target.musicCount} podcast=${target.podcastCount}`,
    );
    for (const [index, item] of target.items.entries()) {
      if (item.type === "MUSIC") {
        console.log(
          `  ${String(index + 1).padStart(2)}. MUSIC ${item.artist ?? "?"} — ${item.title} | ${item.discoveryCategory ?? "UNSCORED"} score=${item.discoveryScore ?? "-"} match=${item.discoveryMatchSource ?? "-"}`,
        );
      } else {
        console.log(`  ${String(index + 1).padStart(2)}. PODCAST ${item.title}`);
      }
    }
  }
}

function requestMetricsDelta(
  before: RequestMetricsSnapshot,
  after: RequestMetricsSnapshot,
) {
  const operations = new Set([
    ...Object.keys(before.callsByOperation),
    ...Object.keys(after.callsByOperation),
  ]);
  return {
    totalCalls: Math.max(0, after.totalCalls - before.totalCalls),
    callsByOperation: Object.fromEntries(
      [...operations]
        .map((operation) => [
          operation,
          Math.max(
            0,
            (after.callsByOperation[operation] ?? 0) -
              (before.callsByOperation[operation] ?? 0),
          ),
        ] as const)
        .filter(([, count]) => count > 0),
    ),
    rateLimitedCount: Math.max(
      0,
      after.rateLimitedCount - before.rateLimitedCount,
    ),
    quotaExceededCount: Math.max(
      0,
      after.quotaExceededCount - before.quotaExceededCount,
    ),
    retries: Math.max(0, after.retries - before.retries),
    retryWaitMs: Math.max(0, after.retryWaitMs - before.retryWaitMs),
  };
}

function itemEvidence(
  item: Candidate,
  entries: Array<{
    candidate: Candidate;
    category: string;
    score: number | null;
    matchSource: string;
    matchedScoreTrackId: string | null;
  }>,
) {
  const discovery =
    item.type === "MUSIC"
      ? entries.find((entry) => entry.candidate.uri === item.uri) ?? null
      : null;
  return {
    uri: item.uri,
    type: item.type,
    title: item.title,
    artist: item.primaryArtistName ?? item.subtitle ?? null,
    spotifyTrackId: item.spotifyTrackId ?? null,
    durationMs: item.durationMs,
    discoveryCategory: discovery?.category ?? null,
    discoveryScore: discovery?.score ?? null,
    discoveryMatchSource: discovery?.matchSource ?? null,
    matchedScoreTrackId: discovery?.matchedScoreTrackId ?? null,
  };
}

function toRunTarget(
  target: TargetPlaylist,
  durationMs: number,
  maxPodcastDurationMs: number | null,
  durationBlocks?: DurationPlanningBlock[],
): RunTarget {
  const sequencePattern = parseSequencePattern(target.sequencePattern);
  if (target.compositionMode === "SEQUENCE" && sequencePattern.length === 0) {
    throw new Error(`Target "${target.name}" has an invalid sequence composition`);
  }
  return {
    targetPlaylistId: target.id,
    name: target.name,
    priority: target.priority,
    ...(durationBlocks ? { durationBlocks } : {}),
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

function minutes(ms: number): string {
  return (ms / 60_000).toFixed(1);
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function parseArgs(argv: string[]): Args {
  let email = "";
  let targetId: string | null = null;
  let asOf = new Date();
  let rediscoveryCeiling: number | undefined;
  let json = false;

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      continue;
    }
    if (arg.startsWith("--target-id=")) {
      targetId = arg.slice("--target-id=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--as-of=")) {
      const parsed = new Date(arg.slice("--as-of=".length));
      if (Number.isNaN(parsed.getTime())) {
        throw new Error("--as-of must be a valid ISO date/time");
      }
      asOf = parsed;
      continue;
    }
    if (arg.startsWith("--rediscovery-ceiling=")) {
      rediscoveryCeiling = Number(arg.slice("--rediscovery-ceiling=".length));
      if (
        !Number.isFinite(rediscoveryCeiling) ||
        rediscoveryCeiling < 0 ||
        rediscoveryCeiling > 1
      ) {
        throw new Error("--rediscovery-ceiling must be between 0 and 1");
      }
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return { email, targetId, asOf, rediscoveryCeiling, json };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
