import { spawnSync } from "node:child_process";

import type { TargetPlaylist } from "@prisma/client";

import { resolveTargetDuration } from "@/jobs/generate-playlists-incremental";
import { prisma } from "@/lib/prisma";
import { calendarDurationPlanningBlocks } from "@/services/calendar-duration-strategy";
import { getCompleteMusicDiscoveryProfile } from "@/services/music-discovery/complete-profile";
import {
  blendResolvedDiscoveryIntoPlannerPool,
  type Gate5FPlannerPoolEntry,
  type Gate5FResolvedDiscoveryCandidate,
} from "@/services/music-discovery/planner-discovery-gate5f";
import {
  buildGate3CHybridPlannerPreview,
  collectCompleteDiscoveryMusicUniverse,
} from "@/services/music-discovery/planner-preview-gate3c";
import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";
import { loadPendingInferredSkips } from "@/services/music-preference";
import {
  parseSequencePattern,
  planRun,
  type Candidate,
  type DurationPlanningBlock,
  type PlanRunResult,
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
  discoveryCeiling: number | undefined;
  json: boolean;
};

type Gate5EPayload = {
  user: string;
  spotify: {
    resolvedCount: number;
    ambiguousCount: number;
    notFoundCount: number;
    providerFailureCount: number;
    metrics: {
      totalCalls: number;
      failures: number;
      rateLimitedCount: number;
      retries: number;
    };
  };
  rows: Array<{
    candidate: {
      candidateKey: string;
      historyClass: string;
      scoreCard: { score: number };
      arbitrationAdjustedScore: number;
      pathLabel: string;
    };
    resolution: {
      status: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";
      reason: string;
      spotifyArtist: {
        id: string;
        name: string;
        uri: string;
      } | null;
      spotifyTrack: {
        id: string;
        name: string;
        uri: string;
        isrc: string | null;
        albumId: string | null;
        albumName: string | null;
        durationMs: number;
        artists: Array<{ id: string; name: string }>;
      } | null;
    } | null;
    failure: { error: string } | null;
  }>;
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

  const [musicUniverseRaw, completeProfile, trackIdentities, repeatContext] =
    await Promise.all([
      collectCompleteDiscoveryMusicUniverse(cursors),
      getCompleteMusicDiscoveryProfile(user.id, { asOf: args.asOf }),
      getDiscoveryTrackIdentityEvidence(user.id),
      loadMusicRepeatContext(user.id, args.asOf),
    ]);

  const repeatFiltered = filterMusicCandidatesForRepeat(
    musicUniverseRaw.sourceUniverse.music,
    repeatContext,
  );
  const profileCooldownByTrackId = new Map(
    completeProfile.tracks.map((track) => [track.spotifyTrackId, track.cooldownEligible] as const),
  );
  const safeMusic = repeatFiltered.candidates.filter((candidate) => {
    const trackId = candidate.spotifyTrackId;
    if (!trackId) return true;
    const eligible = profileCooldownByTrackId.get(trackId);
    return eligible !== false && eligible !== null;
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

  const baseline = await buildGate3CHybridPlannerPreview({
    profile: completeProfile,
    musicUniverse,
    trackIdentities,
    targets: runTargets,
    podcastSources: cursors.filter((source) => source.kind === "PODCAST"),
    blockedMusicTrackIdsByTargetId,
    rediscoveryCeiling: args.rediscoveryCeiling,
  });

  // Gate 5F first proves that a deterministic replay with the exact candidates
  // observed by Gate 3C reproduces the same final plan. Only then is the MUSIC
  // pool changed. This isolates DESCOBERTA from provider timing / cursor drift.
  const baselineReplay = planRun({
    pools: {
      music: baseline.selection.plannerPool.music,
      podcasts: baseline.podcastCandidatesRead,
    },
    targets: runTargets,
    blockedMusicTrackIdsByTargetId,
  });
  const baselineReplayEquivalent = plansEquivalent(
    baseline.incremental.plan,
    baselineReplay,
  );

  const gate5e = runGate5E(args.email);
  const discoveries = gate5e.rows
    .map(toResolvedDiscovery)
    .filter((row): row is Gate5FResolvedDiscoveryCandidate => Boolean(row));
  const blend = blendResolvedDiscoveryIntoPlannerPool({
    baseline: baseline.selection.plannerPool.entries,
    discoveries,
    discoveryCeiling: args.discoveryCeiling,
  });

  const previewPlan = planRun({
    pools: {
      music: blend.music,
      podcasts: baseline.podcastCandidatesRead,
    },
    targets: runTargets,
    blockedMusicTrackIdsByTargetId,
  });
  const previewReady = baselineReplayEquivalent;
  const entryByUri = new Map(blend.entries.map((entry) => [entry.candidate.uri, entry] as const));
  const discoveryTrackIds = new Set(
    blend.entries
      .filter((entry) => entry.category === "DESCOBERTA")
      .map((entry) => entry.candidate.spotifyTrackId)
      .filter((value): value is string => Boolean(value)),
  );

  const payload = {
    user: user.email ?? user.id,
    generatedAt: args.asOf,
    gate: "DISCOVERY-01 Gate 5F",
    mode: "READ_ONLY" as const,
    previewReady,
    policy: {
      discovery: blend.evidence,
      rediscoveryCeiling: baseline.selection.plannerPool.evidence.rediscoveryCeiling,
      unresolvedSpotifyCandidatesEnterPlanner: false,
      podcastReplayPolicy: "EXACT_GATE3C_OBSERVED_CANDIDATES",
      writerEnabled: false,
    },
    sourceGate: {
      gate5eResolved: gate5e.spotify.resolvedCount,
      gate5eAmbiguous: gate5e.spotify.ambiguousCount,
      gate5eNotFound: gate5e.spotify.notFoundCount,
      gate5eProviderFailures: gate5e.spotify.providerFailureCount,
      spotifyCatalogCalls: gate5e.spotify.metrics.totalCalls,
    },
    baseline: {
      version: baseline.version,
      replayEquivalent: baselineReplayEquivalent,
      musicPoolCount: baseline.selection.plannerPool.music.length,
      podcastCandidatesRead: baseline.podcastCandidatesRead.length,
      targetCount: baseline.incremental.plan.targets.length,
    },
    blend: {
      ...blend.evidence,
      rejected: blend.rejected.map((row) => ({
        candidateKey: row.discovery.candidateKey,
        reason: row.reason,
      })),
    },
    skippedTargets,
    targets: previewPlan.targets.map((target) => {
      const baselineTarget = baseline.incremental.plan.targets.find(
        (row) => row.targetPlaylistId === target.targetPlaylistId,
      );
      if (!baselineTarget) {
        throw new Error(`Missing Gate 3C baseline target ${target.targetPlaylistId}`);
      }
      return compareTargetPlans(
        baselineTarget,
        target,
        entryByUri,
        discoveryTrackIds,
      );
    }),
    writePolicy: {
      spotifyPlaylistWrites: false,
      music03Writes: false,
      historyWrites: false,
      preferenceWrites: false,
      plannerPersistenceWrites: false,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 5F CONTROLLED PLANNER PREVIEW ==========");
  console.log(`User:                         ${payload.user}`);
  console.log(`Preview ready:                ${payload.previewReady}`);
  console.log(`Gate 3C replay equivalent:    ${payload.baseline.replayEquivalent}`);
  console.log(`Gate 5E resolved:             ${payload.sourceGate.gate5eResolved}`);
  console.log(`Gate 5E ambiguous:            ${payload.sourceGate.gate5eAmbiguous}`);
  console.log(`Discovery pool accepted:      ${payload.blend.acceptedDiscoveryCount}`);
  console.log(`Discovery pool rejected:      ${payload.blend.rejectedDiscoveryCount}`);
  console.log(
    `Discovery ceiling:           ${(payload.blend.discoveryCeiling * 100).toFixed(1)}%`,
  );
  console.log(`Discovery pool positions:     ${payload.blend.discoveryPositions.join(", ") || "none"}`);
  console.log(`Podcast replay candidates:    ${payload.baseline.podcastCandidatesRead}`);

  for (const target of payload.targets) {
    console.log(`\n[${target.name}] quality ${target.baseline.qualityPassed} -> ${target.preview.qualityPassed}`);
    console.log(
      `  duration ${minutes(target.baseline.totalDurationMs)} -> ${minutes(target.preview.totalDurationMs)} min (${signedMs(target.durationDeltaMs)})`,
    );
    console.log(
      `  mix MUSIC/PODCAST ${target.baseline.musicCount}/${target.baseline.podcastCount} -> ${target.preview.musicCount}/${target.preview.podcastCount}`,
    );
    console.log(`  podcast sequence unchanged: ${target.podcastSequenceUnchanged}`);
    console.log(`  discoveries selected:       ${target.discoveries.length}`);
    for (const row of target.discoveries) {
      console.log(
        `    pos ${row.position}: ${row.artist ?? "?"} — ${row.title} | score=${row.score ?? "-"} | replaces@same-pos=${row.baselineAtSamePosition ?? "none"}`,
      );
    }
    if (target.displacedBaselineMusic.length > 0) {
      console.log("  baseline MUSIC displaced:");
      for (const row of target.displacedBaselineMusic) {
        console.log(`    ${row.artist ?? "?"} — ${row.title}`);
      }
    }
  }

  console.log("\nNo writes: preview only; no Spotify playlist, MUSIC-03, history, preference or planner persistence changes.");
}

function runGate5E(email: string): Gate5EPayload {
  const command = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const result = spawnSync(
    command,
    ["scripts/report-music-discovery-spotify-resolution.ts", `--email=${email}`, "--json"],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`Gate 5E source report failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as Gate5EPayload;
  } catch (error) {
    throw new Error(
      `Gate 5E source report did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toResolvedDiscovery(
  row: Gate5EPayload["rows"][number],
): Gate5FResolvedDiscoveryCandidate | null {
  const resolution = row.resolution;
  if (
    row.failure ||
    !resolution ||
    resolution.status !== "RESOLVED" ||
    !resolution.spotifyArtist ||
    !resolution.spotifyTrack
  ) {
    return null;
  }
  const track = resolution.spotifyTrack;
  const artist = resolution.spotifyArtist;
  const candidate: Candidate = {
    uri: track.uri,
    type: "MUSIC",
    title: track.name,
    subtitle: artist.name,
    spotifyTrackId: track.id,
    primaryArtistId: artist.id,
    primaryArtistName: artist.name,
    ...(track.albumId ? { albumId: track.albumId } : {}),
    ...(track.albumName ? { albumName: track.albumName } : {}),
    durationMs: track.durationMs,
  };
  return {
    candidateKey: row.candidate.candidateKey,
    candidate,
    rawScore: row.candidate.scoreCard.score,
    adjustedScore: row.candidate.arbitrationAdjustedScore,
    historyClass: row.candidate.historyClass,
    pathLabel: row.candidate.pathLabel,
    resolutionReason: resolution.reason,
    isrc: track.isrc,
  };
}

function plansEquivalent(a: PlanRunResult, b: PlanRunResult): boolean {
  if (a.targets.length !== b.targets.length) return false;
  return a.targets.every((target, index) => {
    const other = b.targets[index];
    if (!other || target.targetPlaylistId !== other.targetPlaylistId) return false;
    if (target.result.items.length !== other.result.items.length) return false;
    return target.result.items.every(
      (item, itemIndex) => item.uri === other.result.items[itemIndex]?.uri,
    );
  });
}

function compareTargetPlans(
  baseline: PlanRunResult["targets"][number],
  preview: PlanRunResult["targets"][number],
  entryByUri: Map<string, Gate5FPlannerPoolEntry>,
  discoveryTrackIds: Set<string>,
) {
  const baselineUris = new Set(baseline.result.items.map((item) => item.uri));
  const previewUris = new Set(preview.result.items.map((item) => item.uri));
  const baselinePodcastUris = baseline.result.items
    .filter((item) => item.type === "PODCAST")
    .map((item) => item.uri);
  const previewPodcastUris = preview.result.items
    .filter((item) => item.type === "PODCAST")
    .map((item) => item.uri);

  const discoveries = preview.result.items.flatMap((item, index) => {
    if (
      item.type !== "MUSIC" ||
      !item.spotifyTrackId ||
      !discoveryTrackIds.has(item.spotifyTrackId)
    ) {
      return [];
    }
    const entry = entryByUri.get(item.uri);
    const baselineAtSamePosition = baseline.result.items[index];
    return [{
      position: index + 1,
      uri: item.uri,
      spotifyTrackId: item.spotifyTrackId,
      artist: item.primaryArtistName ?? item.subtitle ?? null,
      title: item.title,
      score: entry?.score ?? null,
      historyClass: entry?.historyClass ?? null,
      pathLabel: entry?.pathLabel ?? null,
      resolutionReason: entry?.resolutionReason ?? null,
      baselineAtSamePosition: baselineAtSamePosition
        ? `${baselineAtSamePosition.primaryArtistName ?? baselineAtSamePosition.subtitle ?? baselineAtSamePosition.type} — ${baselineAtSamePosition.title}`
        : null,
    }];
  });

  const displacedBaselineMusic = baseline.result.items
    .filter((item) => item.type === "MUSIC" && !previewUris.has(item.uri))
    .map((item) => ({
      uri: item.uri,
      spotifyTrackId: item.spotifyTrackId ?? null,
      artist: item.primaryArtistName ?? item.subtitle ?? null,
      title: item.title,
      category: entryByUri.get(item.uri)?.category ?? null,
    }));

  const addedMusicNotDiscovery = preview.result.items
    .filter(
      (item) =>
        item.type === "MUSIC" &&
        !baselineUris.has(item.uri) &&
        (!item.spotifyTrackId || !discoveryTrackIds.has(item.spotifyTrackId)),
    )
    .map((item) => ({ uri: item.uri, title: item.title }));

  return {
    targetPlaylistId: preview.targetPlaylistId,
    name: preview.name,
    baseline: planSummary(baseline.result),
    preview: planSummary(preview.result),
    durationDeltaMs:
      preview.result.stats.totalDurationMs - baseline.result.stats.totalDurationMs,
    podcastSequenceUnchanged:
      JSON.stringify(baselinePodcastUris) === JSON.stringify(previewPodcastUris),
    discoveries,
    displacedBaselineMusic,
    addedMusicNotDiscovery,
    categories: categoryCounts(preview.result.items, entryByUri),
  };
}

function planSummary(result: PlanRunResult["targets"][number]["result"]) {
  return {
    qualityPassed: result.stats.compositionQualityPassed,
    totalDurationMs: result.stats.totalDurationMs,
    musicDurationMs: result.stats.musicDurationMs,
    podcastDurationMs: result.stats.podcastDurationMs,
    musicCount: result.stats.musicCount,
    podcastCount: result.stats.podcastCount,
    requestedPodcastPercent: result.stats.requestedPodcastPercent,
    actualPodcastPercent: result.stats.actualPodcastPercent,
    mixDeviationPoints: result.stats.mixDeviationPoints,
    sequenceStopReason: result.stats.sequenceStopReason,
    segmentationDeficitMs: result.stats.segmentation?.deficitMs ?? 0,
  };
}

function categoryCounts(
  items: Candidate[],
  entryByUri: Map<string, Gate5FPlannerPoolEntry>,
): Record<string, number> {
  const counts: Record<string, number> = {
    DESCOBERTA: 0,
    REDESCOBERTA: 0,
    FAMILIAR: 0,
    SOURCE_FALLBACK: 0,
    UNSCORED: 0,
  };
  for (const item of items) {
    if (item.type !== "MUSIC") continue;
    const category = entryByUri.get(item.uri)?.category ?? "UNSCORED";
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
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

function signedMs(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds >= 0 ? "+" : ""}${seconds}s`;
}

function parseArgs(argv: string[]): Args {
  let email = "";
  let targetId: string | null = null;
  let asOf = new Date();
  let rediscoveryCeiling: number | undefined;
  let discoveryCeiling: number | undefined;
  let json = false;

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
    } else if (arg.startsWith("--target-id=")) {
      targetId = arg.slice("--target-id=".length).trim() || null;
    } else if (arg.startsWith("--as-of=")) {
      const parsed = new Date(arg.slice("--as-of=".length));
      if (Number.isNaN(parsed.getTime())) throw new Error("--as-of must be a valid ISO date/time");
      asOf = parsed;
    } else if (arg.startsWith("--rediscovery-ceiling=")) {
      rediscoveryCeiling = boundedNumber(arg, "--rediscovery-ceiling=", 0, 1);
    } else if (arg.startsWith("--discovery-ceiling=")) {
      discoveryCeiling = boundedNumber(arg, "--discovery-ceiling=", 0, 1);
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return { email, targetId, asOf, rediscoveryCeiling, discoveryCeiling, json };
}

function boundedNumber(arg: string, prefix: string, min: number, max: number): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} must be between ${min} and ${max}`);
  }
  return value;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
