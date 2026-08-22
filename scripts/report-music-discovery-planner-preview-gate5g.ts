import { spawnSync } from "node:child_process";

import type { TargetPlaylist } from "@prisma/client";

import { resolveTargetDuration } from "@/jobs/generate-playlists-incremental";
import { prisma } from "@/lib/prisma";
import { calendarDurationPlanningBlocks } from "@/services/calendar-duration-strategy";
import { getCompleteMusicDiscoveryProfile } from "@/services/music-discovery/complete-profile";
import type { Gate5FResolvedDiscoveryCandidate } from "@/services/music-discovery/planner-discovery-gate5f";
import {
  DISCOVERY_GATE5G_POLICY,
  previewSurgicalDiscoveryRun,
} from "@/services/music-discovery/planner-discovery-gate5g";
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
  musicSpacing: number | undefined;
  maxDurationDeltaMs: number | undefined;
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

  const surgical = previewSurgicalDiscoveryRun({
    baseline: baseline.incremental.plan,
    targets: runTargets,
    discoveries,
    blockedMusicTrackIdsByTargetId,
    discoveryCeiling: args.discoveryCeiling,
    musicSpacing: args.musicSpacing,
    maxDurationDeltaMs: args.maxDurationDeltaMs,
  });

  const baselineEntryByUri = new Map(
    baseline.selection.plannerPool.entries.map((entry) => [entry.candidate.uri, entry] as const),
  );
  const invariantsPassed = surgical.targets.every(
    (target) =>
      target.evidence.podcastSequenceUnchanged &&
      target.evidence.podcastCountUnchanged &&
      target.evidence.musicCountUnchanged &&
      target.evidence.oneForOneReplacement &&
      target.evidence.compositionQualityPreserved &&
      Math.abs(target.evidence.durationDeltaMs) <= surgical.evidence.maxDurationDeltaMs &&
      Object.values(target.evidence.blockDurationDeltaMs).every(
        (delta) => Math.abs(delta) <= surgical.evidence.maxDurationDeltaMs,
      ),
  );
  const previewReady = baselineReplayEquivalent && invariantsPassed;

  const payload = {
    user: user.email ?? user.id,
    generatedAt: args.asOf,
    gate: "DISCOVERY-01 Gate 5G",
    mode: "READ_ONLY" as const,
    previewReady,
    policy: {
      ...DISCOVERY_GATE5G_POLICY,
      discoveryCeiling: surgical.evidence.discoveryCeiling,
      musicSpacing: surgical.evidence.musicSpacing,
      maxDurationDeltaMs: surgical.evidence.maxDurationDeltaMs,
      unresolvedSpotifyCandidatesEnterPreview: false,
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
    surgical: surgical.evidence,
    invariantsPassed,
    skippedTargets,
    targets: surgical.targets.map((target) => {
      const baselineTarget = baseline.incremental.plan.targets.find(
        (row) => row.targetPlaylistId === target.targetPlaylistId,
      );
      if (!baselineTarget) {
        throw new Error(`Missing Gate 3C baseline target ${target.targetPlaylistId}`);
      }
      const rejectionCounts = Object.fromEntries(
        [...new Set(target.attemptsRejected.map((row) => row.reason))]
          .sort()
          .map((reason) => [
            reason,
            target.attemptsRejected.filter((row) => row.reason === reason).length,
          ]),
      );
      return {
        targetPlaylistId: target.targetPlaylistId,
        name: target.name,
        baseline: planSummary(baselineTarget.result),
        preview: {
          totalDurationMs: target.items.reduce(
            (sum, item) => sum + Math.max(0, item.durationMs),
            0,
          ),
          musicCount: target.items.filter((item) => item.type === "MUSIC").length,
          podcastCount: target.items.filter((item) => item.type === "PODCAST").length,
        },
        evidence: target.evidence,
        replacements: target.replacements.map((replacement) => ({
          candidateKey: replacement.candidateKey,
          overallPosition: replacement.overallPosition,
          musicOrdinal: replacement.musicOrdinal,
          baseline: {
            uri: replacement.baseline.uri,
            artist:
              replacement.baseline.primaryArtistName ??
              replacement.baseline.subtitle ??
              null,
            title: replacement.baseline.title,
            category:
              baselineEntryByUri.get(replacement.baseline.uri)?.category ?? null,
            durationMs: replacement.baseline.durationMs,
          },
          discovery: {
            uri: replacement.discovery.uri,
            spotifyTrackId: replacement.discovery.spotifyTrackId ?? null,
            artist:
              replacement.discovery.primaryArtistName ??
              replacement.discovery.subtitle ??
              null,
            title: replacement.discovery.title,
            durationMs: replacement.discovery.durationMs,
            rawScore: replacement.rawScore,
            adjustedScore: replacement.adjustedScore,
            historyClass: replacement.historyClass,
            pathLabel: replacement.pathLabel,
            resolutionReason: replacement.resolutionReason,
          },
          durationDeltaMs: replacement.durationDeltaMs,
        })),
        rejectionCounts,
      };
    }),
    unusedDiscoveries: surgical.unusedDiscoveries.map((row) => ({
      candidateKey: row.candidateKey,
      artist: row.candidate.primaryArtistName ?? row.candidate.subtitle ?? null,
      title: row.candidate.title,
      adjustedScore: row.adjustedScore,
    })),
    invalidDiscoveries: surgical.invalidDiscoveries.map((row) => row.candidateKey),
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

  console.log("========== DISCOVERY-01 — GATE 5G SURGICAL REPLACEMENT READ-ONLY ==========");
  console.log(`User:                         ${payload.user}`);
  console.log(`Preview ready:                ${payload.previewReady}`);
  console.log(`Gate 3C replay equivalent:    ${payload.baseline.replayEquivalent}`);
  console.log(`All surgical invariants:      ${payload.invariantsPassed}`);
  console.log(`Gate 5E resolved:             ${payload.sourceGate.gate5eResolved}`);
  console.log(`Gate 5E ambiguous:            ${payload.sourceGate.gate5eAmbiguous}`);
  console.log(`Discovery selected globally:  ${payload.surgical.selectedDiscoveryCount}`);
  console.log(`Discovery unused:             ${payload.surgical.unusedDiscoveryCount}`);
  console.log(`Discovery invalid:            ${payload.surgical.invalidDiscoveryCount}`);
  console.log(
    `Final MUSIC ceiling:          ${(payload.surgical.discoveryCeiling * 100).toFixed(1)}%`,
  );
  console.log(`MUSIC spacing:                every ${payload.surgical.musicSpacing}th MUSIC slot`);
  console.log(
    `Duration tolerance:           ±${(payload.surgical.maxDurationDeltaMs / 1_000).toFixed(0)}s per replacement/target/block`,
  );

  for (const target of payload.targets) {
    console.log(`\n[${target.name}]`);
    console.log(
      `  baseline MUSIC/PODCAST: ${target.baseline.musicCount}/${target.baseline.podcastCount}`,
    );
    console.log(
      `  preview  MUSIC/PODCAST: ${target.preview.musicCount}/${target.preview.podcastCount}`,
    );
    console.log(
      `  eligible MUSIC ordinals: ${target.evidence.eligibleMusicOrdinals.join(", ") || "none"}`,
    );
    console.log(`  discoveries selected:    ${target.replacements.length}`);
    console.log(`  discovery final share:   ${(target.evidence.discoveryShare * 100).toFixed(1)}%`);
    console.log(`  duration delta:          ${signedMs(target.evidence.durationDeltaMs)}`);
    console.log(`  podcasts exact/order:    ${target.evidence.podcastSequenceUnchanged}`);
    console.log(`  MUSIC count unchanged:   ${target.evidence.musicCountUnchanged}`);
    console.log(`  one-for-one:             ${target.evidence.oneForOneReplacement}`);
    console.log(
      `  quality:                 ${target.evidence.compositionQualityBefore} -> ${target.evidence.compositionQualityAfter}`,
    );
    for (const replacement of target.replacements) {
      console.log(
        `    MUSIC#${replacement.musicOrdinal} / pos ${replacement.overallPosition}: ${replacement.baseline.artist ?? "?"} — ${replacement.baseline.title} [${replacement.baseline.category ?? "UNSCORED"}] -> ${replacement.discovery.artist ?? "?"} — ${replacement.discovery.title} | score=${replacement.discovery.adjustedScore} | Δ=${signedMs(replacement.durationDeltaMs)}`,
      );
    }
    const rejectionEntries = Object.entries(target.rejectionCounts);
    if (rejectionEntries.length > 0) {
      console.log(
        `  rejected attempts:       ${rejectionEntries.map(([reason, count]) => `${reason}=${count}`).join(", ")}`,
      );
    }
  }

  if (payload.unusedDiscoveries.length > 0) {
    console.log("\nUnused resolved discoveries (no safe slot):");
    for (const row of payload.unusedDiscoveries) {
      console.log(`  ${row.artist ?? "?"} — ${row.title} | score=${row.adjustedScore}`);
    }
  }

  console.log(
    "\nNo writes: baseline remains authoritative; preview only; no Spotify playlist, MUSIC-03, history, preference or planner persistence changes.",
  );
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

function planSummary(result: PlanRunResult["targets"][number]["result"]) {
  return {
    totalDurationMs: result.stats.totalDurationMs,
    musicCount: result.stats.musicCount,
    podcastCount: result.stats.podcastCount,
    qualityPassed: result.stats.compositionQualityPassed,
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
  let musicSpacing: number | undefined;
  let maxDurationDeltaMs: number | undefined;
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
      if (!Number.isFinite(rediscoveryCeiling) || rediscoveryCeiling < 0 || rediscoveryCeiling > 1) {
        throw new Error("--rediscovery-ceiling must be between 0 and 1");
      }
      continue;
    }
    if (arg.startsWith("--discovery-ceiling=")) {
      discoveryCeiling = Number(arg.slice("--discovery-ceiling=".length));
      if (!Number.isFinite(discoveryCeiling) || discoveryCeiling < 0 || discoveryCeiling > 1) {
        throw new Error("--discovery-ceiling must be between 0 and 1");
      }
      continue;
    }
    if (arg.startsWith("--music-spacing=")) {
      musicSpacing = Number(arg.slice("--music-spacing=".length));
      if (!Number.isInteger(musicSpacing) || musicSpacing < 1) {
        throw new Error("--music-spacing must be a positive integer");
      }
      continue;
    }
    if (arg.startsWith("--max-duration-delta-seconds=")) {
      const seconds = Number(arg.slice("--max-duration-delta-seconds=".length));
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error("--max-duration-delta-seconds must be non-negative");
      }
      maxDurationDeltaMs = Math.round(seconds * 1_000);
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return {
    email,
    targetId,
    asOf,
    rediscoveryCeiling,
    discoveryCeiling,
    musicSpacing,
    maxDurationDeltaMs,
    json,
  };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
