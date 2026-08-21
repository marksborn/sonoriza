import type { TargetPlaylist } from "@prisma/client";

import { resolveTargetDuration } from "@/jobs/generate-playlists-incremental";
import { prisma } from "@/lib/prisma";
import { calendarDurationPlanningBlocks } from "@/services/calendar-duration-strategy";
import { getCompleteMusicDiscoveryProfile } from "@/services/music-discovery/complete-profile";
import {
  buildCompleteDiscoveryPlannerPreview,
  collectCompleteDiscoverySourceUniverse,
} from "@/services/music-discovery/planner-preview";
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

  const [sourceUniverseRaw, completeProfile, trackIdentities, repeatContext] =
    await Promise.all([
      collectCompleteDiscoverySourceUniverse(cursors),
      getCompleteMusicDiscoveryProfile(user.id, { asOf: args.asOf }),
      getDiscoveryTrackIdentityEvidence(user.id),
      loadMusicRepeatContext(user.id, args.asOf),
    ]);

  // Preview intentionally does not sync Recently Played. It uses persisted
  // MUSIC-01 state plus Gate 1.1's safer timeline reconciliation, so a stale
  // TrackListeningState cannot turn a known recently-played track into fallback.
  const repeatFiltered = filterMusicCandidatesForRepeat(
    sourceUniverseRaw.music,
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
  const sourceUniverse = {
    ...sourceUniverseRaw,
    music: safeMusic,
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

  const preview = buildCompleteDiscoveryPlannerPreview({
    profile: completeProfile,
    sourceUniverse,
    trackIdentities,
    targets: runTargets,
    blockedMusicTrackIdsByTargetId,
    rediscoveryCeiling: args.rediscoveryCeiling,
  });
  const spotifyApi = reader.getRequestMetrics();

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
        "The production source reader may refresh operational source caches / observed podcast state while reading; this preview never writes a target playlist.",
    },
    targetScope: args.targetId,
    skippedTargets,
    completeUniverse: {
      historyArtists: preview.evidence.historyArtistCount,
      historyTracks: preview.evidence.historyTrackCount,
      sourceCount: sourceUniverseRaw.evidence.sourceCount,
      sourceMusicBeforeCooldown: sourceUniverseRaw.music.length,
      sourceMusicAfterCooldown: safeMusic.length,
      sourcePodcasts: sourceUniverseRaw.podcasts.length,
      sourceReadCalls: sourceUniverseRaw.evidence.readCalls,
      everySourceDone: sourceUniverseRaw.evidence.sources.every((source) => source.done),
      selectionReady: preview.scoring.selectionPolicy.selectionReady,
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
      version: preview.scoring.version,
      candidateUniverse: preview.scoring.selectionPolicy.candidateUniverse,
      selectionReady: preview.scoring.selectionPolicy.selectionReady,
      categoryBudgetRule: preview.scoring.selectionPolicy.categoryBudgetRule,
    },
    bridge: preview.plannerPool.evidence,
    sourceCollection: sourceUniverseRaw.evidence,
    spotifyApi,
    targets: preview.plan.targets.map((target) => ({
      targetPlaylistId: target.targetPlaylistId,
      name: target.name,
      qualityPassed: target.result.stats.compositionQualityPassed,
      totalDurationMs: target.result.stats.totalDurationMs,
      musicDurationMs: target.result.stats.musicDurationMs,
      podcastDurationMs: target.result.stats.podcastDurationMs,
      musicCount: target.result.stats.musicCount,
      podcastCount: target.result.stats.podcastCount,
      poolExhausted: target.result.stats.poolExhausted,
      items: target.result.items.map((item) => itemEvidence(item, preview.plannerPool.entries)),
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 3B COMPLETE PLANNER PREVIEW ==========");
  console.log(`User:                 ${payload.user}`);
  console.log(`As of:                ${args.asOf.toISOString()}`);
  console.log(`History universe:     ${payload.completeUniverse.historyArtists} artists / ${payload.completeUniverse.historyTracks} tracks`);
  console.log(`Source universe:      ${payload.completeUniverse.sourceMusicBeforeCooldown} music / ${payload.completeUniverse.sourcePodcasts} podcasts`);
  console.log(`Sources fully read:   ${payload.completeUniverse.everySourceDone} (${payload.completeUniverse.sourceReadCalls} read calls)`);
  console.log(`After MUSIC-01:       ${payload.completeUniverse.sourceMusicAfterCooldown} music candidates`);
  console.log(`Selection ready:      ${payload.completeUniverse.selectionReady}`);
  console.log(`Score universe:       ${payload.scoring.candidateUniverse}`);
  console.log(`Rediscovery ceiling:  ${preview.plannerPool.evidence.rediscoveryCeiling}`);
  console.log("Playlist writes:      NONE (preview only)");
  console.log(
    "Operational note: source cache / observed podcast state may refresh while the real source reader is exhausted.",
  );

  for (const target of payload.targets) {
    console.log(`\n[${target.name}] quality=${target.qualityPassed} total=${minutes(target.totalDurationMs)} min music=${target.musicCount} podcast=${target.podcastCount}`);
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
      if (Number.isNaN(parsed.getTime())) throw new Error("--as-of must be a valid ISO date/time");
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