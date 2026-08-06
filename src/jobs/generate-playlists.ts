import type { RunStatus, RunTrigger, TargetPlaylist } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { computeTripDurationMs } from "@/services/google-calendar";
import {
  parseSequencePattern,
  planRun,
  type Candidate,
  type PlannerPools,
  type RunTarget,
} from "@/services/playlist-planner";
import { SpotifyClient } from "@/services/spotify";

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

/**
 * End-to-end generation for one user:
 *   1. build candidate pools from the user's Spotify sources;
 *   2. resolve each target's duration (fixed or from the calendar);
 *   3. plan every target in priority order (cross-playlist exclusivity);
 *   4. apply the plans to Spotify (unless simulating);
 *   5. persist the run, its items, logs and a structured summary.
 *
 * A failure while applying a single target degrades the run to PARTIAL rather
 * than aborting the others.
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
  const summary: Record<string, unknown> = { simulate, targets: [] as unknown[] };

  let status: RunStatus = "SUCCESS";

  try {
    const spotify = await SpotifyClient.forUser(userId);

    // --- 1. Build shared candidate pools -----------------------------------
    const sources = await prisma.sourcePlaylist.findMany({
      where: { userId, enabled: true },
    });

    const pools = await buildPools(spotify, sources, log);
    log({
      level: "INFO",
      message: `Pools built: ${pools.music.length} tracks, ${pools.podcasts.length} episodes`,
    });

    // --- 2. Resolve targets + durations ------------------------------------
    const targets = await prisma.targetPlaylist.findMany({
      where: { userId, enabled: true },
      orderBy: { priority: "asc" },
    });

    const tripCalendarIds = (
      await prisma.calendarSelection.findMany({
        where: { userId, selected: true, usedForTrips: true },
      })
    ).map((c) => c.googleCalendarId);

    const runTargets: RunTarget[] = [];
    const skipped: TargetPlaylist[] = [];

    for (const target of targets) {
      const durationMs = await resolveTargetDurationMs(
        userId,
        target,
        tripCalendarIds,
        date,
        log,
      );

      // Calendar target with no trips → apply the configured empty behaviour.
      if (target.durationMode === "CALENDAR" && durationMs <= 0) {
        if (target.emptyCalendarBehavior === "CLEAR") {
          log({
            level: "INFO",
            message: `Target "${target.name}" has no trips → will be cleared`,
          });
          runTargets.push(toRunTarget(target, 0));
        } else {
          log({
            level: "INFO",
            message: `Target "${target.name}" has no trips → ${target.emptyCalendarBehavior} (untouched)`,
          });
          skipped.push(target);
        }
        continue;
      }

      runTargets.push(toRunTarget(target, durationMs));
    }

    // --- 3. Plan (priority order, shared reservation) ----------------------
    const plan = planRun({ pools, targets: runTargets });

    // --- 4 & 5. Apply + persist per target ---------------------------------
    const targetById = new Map(targets.map((t) => [t.id, t]));
    let anyFailed = false;

    for (const planned of plan.targets) {
      const target = targetById.get(planned.targetPlaylistId)!;
      const { items, stats } = planned.result;

      const targetSummary: Record<string, unknown> = {
        name: target.name,
        planned: items.length,
        ...stats,
        totalMinutes: Math.round(stats.totalDurationMs / 60000),
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
          )} min${simulate ? " (simulated)" : ""}`,
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
    status = anyFailed ? "PARTIAL" : "SUCCESS";

    await finalizeRun(run.id, status, logs, summary);
    return { runId: run.id, status };
  } catch (err) {
    log({ level: "ERROR", message: `Run failed: ${errorMessage(err)}` });
    await finalizeRun(run.id, "FAILED", logs, summary, errorMessage(err));
    return { runId: run.id, status: "FAILED" };
  }
}

// --- helpers ----------------------------------------------------------------

async function buildPools(
  spotify: SpotifyClient,
  sources: { kind: string; spotifyType: string; spotifyId: string }[],
  log: (line: LogLine) => void,
): Promise<PlannerPools> {
  const music: Candidate[] = [];
  const podcasts: Candidate[] = [];

  for (const source of sources) {
    try {
      if (source.kind === "MUSIC" && source.spotifyType === "PLAYLIST") {
        music.push(...(await spotify.getPlaylistTracks(source.spotifyId)));
      } else if (source.kind === "PODCAST" && source.spotifyType === "SHOW") {
        podcasts.push(...(await spotify.getShowEpisodes(source.spotifyId)));
      } else if (source.kind === "PODCAST" && source.spotifyType === "PLAYLIST") {
        // A playlist of episodes: treat its items as podcast candidates.
        const tracks = await spotify.getPlaylistTracks(source.spotifyId);
        podcasts.push(...tracks.map((t) => ({ ...t, type: "PODCAST" as const })));
      }
    } catch (err) {
      log({
        level: "WARN",
        message: `Skipping source ${source.spotifyType}:${source.spotifyId}: ${errorMessage(err)}`,
      });
    }
  }

  return { music: dedupeByUri(music), podcasts: dedupeByUri(podcasts) };
}

async function resolveTargetDurationMs(
  userId: string,
  target: TargetPlaylist,
  tripCalendarIds: string[],
  date: Date,
  log: (line: LogLine) => void,
): Promise<number> {
  if (target.durationMode === "FIXED") {
    return (target.fixedDurationSeconds ?? 0) * 1000;
  }
  const ms = await computeTripDurationMs(userId, tripCalendarIds, date);
  log({
    level: "INFO",
    message: `Calendar duration for "${target.name}": ${Math.round(ms / 60000)} min`,
  });
  return ms;
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
