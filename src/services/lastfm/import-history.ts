import type { LastFmBackfillRun, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { scanLastFmBackfill, type LastFmBackfillCheckpoint } from "./backfill";
import { LastFmClient, type LastFmListeningEventInput } from "./client";

const LASTFM_BACKFILL_PAGE_DELAY_MS = 1_000;

export type ImportLastFmHistoryOptions = {
  userId: string;
  username: string;
  apiKey: string;
  /** Controlled batch size. Omit to scan the entire frozen history window. */
  maxPages?: number;
  /** Resume an existing run; otherwise the latest PARTIAL/RUNNING run is reused. */
  runId?: string;
  /** Explicit exclusive upper boundary for tests/controlled execution. */
  to?: Date;
};

export type ImportLastFmHistoryResult = {
  runId: string;
  status: "SUCCESS" | "PARTIAL";
  completed: boolean;
  nextPage: number;
  totalPages: number | null;
  /** Last whole second that can belong to the Last.fm side of the handoff. */
  lastFmHistoryUntil: Date;
  /** Exact exclusive Last.fm `to` boundary; Spotify owns this instant onward. */
  lastFmHistoryUntilExclusive: Date;
  profilePlayCount: number | null;
  acceptedEvents: number;
  insertedEvents: number;
  duplicateEvents: number;
};

/**
 * HISTORY-01 database orchestration for the read-only Last.fm scanner.
 *
 * Each provider page is persisted transactionally with its checkpoint. If the
 * database operation fails, the checkpoint does not advance and the same page
 * can safely be retried. `skipDuplicates` is backed by the source-event unique
 * key, so retries/restarts are idempotent.
 *
 * Last.fm is a historical backfill source, not a second continuous truth. Its
 * documented `to` boundary is exclusive: it returns only scrobbles strictly
 * before that UNIX-second timestamp. The automatic handoff therefore uses the
 * whole-second timestamp of the first canonical Spotify event (or the current
 * whole second if Spotify history is not seeded yet). Spotify owns events at or
 * after the same boundary.
 *
 * Provider pages are intentionally spaced one second apart. HISTORY-01 is a
 * resumable import, not latency-sensitive user interaction; favoring provider
 * health is more important than finishing a long backfill as fast as possible.
 */
export async function importLastFmHistory(
  options: ImportLastFmHistoryOptions,
): Promise<ImportLastFmHistoryResult> {
  const username = options.username.trim();
  const apiKey = options.apiKey.trim();
  if (!username) throw new Error("Last.fm username is required");
  if (!apiKey) throw new Error("Last.fm API key is required");

  const client = new LastFmClient({ apiKey });
  let run = await resolveRun({
    userId: options.userId,
    username,
    runId: options.runId,
    to: options.to,
  });

  let insertedEvents = run.insertedEvents;
  let duplicateEvents = run.duplicateEvents;

  try {
    const result = await scanLastFmBackfill({
      client,
      username: run.username,
      checkpoint: toCheckpoint(run),
      maxPages: options.maxPages,
      pageDelayMs: LASTFM_BACKFILL_PAGE_DELAY_MS,
      async onPage(page) {
        const eventRows = page.events.map((event) => toEventRow(options.userId, event));
        await prisma.$transaction(async (tx) => {
          const created = eventRows.length
            ? await tx.trackListeningEvent.createMany({
                data: eventRows,
                skipDuplicates: true,
              })
            : { count: 0 };
          const duplicates = eventRows.length - created.count;
          insertedEvents += created.count;
          duplicateEvents += duplicates;

          run = await tx.lastFmBackfillRun.update({
            where: { id: run.id },
            data: {
              status: "RUNNING",
              from: page.checkpointAfter.from,
              to: page.checkpointAfter.to,
              nextPage: page.checkpointAfter.nextPage,
              totalPages: page.checkpointAfter.totalPages,
              scannedProviderRows: page.checkpointAfter.scannedProviderRows,
              acceptedEvents: page.checkpointAfter.acceptedEvents,
              insertedEvents,
              duplicateEvents,
              nowPlayingSkipped: page.checkpointAfter.nowPlayingSkipped,
              invalidSkipped: page.checkpointAfter.invalidSkipped,
              lastPageAt: new Date(),
              error: null,
            },
          });
        });
      },
    });

    const status = result.completed ? "SUCCESS" : "PARTIAL";
    run = await prisma.lastFmBackfillRun.update({
      where: { id: run.id },
      data: {
        status,
        profilePlayCount: result.profile.playCount,
        from: result.checkpoint.from,
        to: result.checkpoint.to,
        nextPage: result.checkpoint.nextPage,
        totalPages: result.checkpoint.totalPages,
        scannedProviderRows: result.checkpoint.scannedProviderRows,
        acceptedEvents: result.checkpoint.acceptedEvents,
        insertedEvents,
        duplicateEvents,
        nowPlayingSkipped: result.checkpoint.nowPlayingSkipped,
        invalidSkipped: result.checkpoint.invalidSkipped,
        finishedAt: result.completed ? new Date() : null,
        error: null,
      },
    });

    return {
      runId: run.id,
      status,
      completed: result.completed,
      nextPage: run.nextPage,
      totalPages: run.totalPages,
      lastFmHistoryUntil: new Date(run.to.getTime() - 1_000),
      lastFmHistoryUntilExclusive: run.to,
      profilePlayCount: run.profilePlayCount,
      acceptedEvents: run.acceptedEvents,
      insertedEvents: run.insertedEvents,
      duplicateEvents: run.duplicateEvents,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await prisma.lastFmBackfillRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: message, finishedAt: new Date() },
      });
    } catch {
      // Preserve the original provider/database failure.
    }
    throw error;
  }
}

async function resolveRun(input: {
  userId: string;
  username: string;
  runId?: string;
  to?: Date;
}): Promise<LastFmBackfillRun> {
  if (input.runId) {
    const explicit = await prisma.lastFmBackfillRun.findFirst({
      where: { id: input.runId, userId: input.userId },
    });
    if (!explicit) throw new Error("Last.fm backfill run not found");
    if (explicit.username.toLocaleLowerCase("en-US") !== input.username.toLocaleLowerCase("en-US")) {
      throw new Error("Last.fm backfill run belongs to another username");
    }
    return reactivate(explicit);
  }

  const resumable = await prisma.lastFmBackfillRun.findFirst({
    where: {
      userId: input.userId,
      username: { equals: input.username, mode: "insensitive" },
      status: { in: ["RUNNING", "PARTIAL", "FAILED"] },
    },
    orderBy: { startedAt: "desc" },
  });
  if (resumable) return reactivate(resumable);

  let handoffAt = input.to ?? null;
  if (!handoffAt) {
    const earliestSpotifyEvent = await prisma.trackListeningEvent.findFirst({
      where: {
        userId: input.userId,
        source: "SPOTIFY_RECENTLY_PLAYED",
      },
      orderBy: { playedAt: "asc" },
      select: { playedAt: true },
    });
    handoffAt = wholeSecond(earliestSpotifyEvent?.playedAt ?? new Date());
  }

  return prisma.lastFmBackfillRun.create({
    data: {
      userId: input.userId,
      username: input.username,
      status: "RUNNING",
      to: handoffAt,
    },
  });
}

async function reactivate(run: LastFmBackfillRun): Promise<LastFmBackfillRun> {
  if (run.status === "SUCCESS") {
    throw new Error("Last.fm backfill run is already complete");
  }
  if (run.status === "RUNNING" && !run.finishedAt) return run;
  return prisma.lastFmBackfillRun.update({
    where: { id: run.id },
    data: { status: "RUNNING", finishedAt: null, error: null },
  });
}

function toCheckpoint(run: LastFmBackfillRun): LastFmBackfillCheckpoint {
  return {
    username: run.username,
    from: run.from,
    to: run.to,
    nextPage: run.nextPage,
    totalPages: run.totalPages,
    scannedProviderRows: run.scannedProviderRows,
    acceptedEvents: run.acceptedEvents,
    nowPlayingSkipped: run.nowPlayingSkipped,
    invalidSkipped: run.invalidSkipped,
  };
}

function toEventRow(
  userId: string,
  event: LastFmListeningEventInput,
): Prisma.TrackListeningEventCreateManyInput {
  return {
    userId,
    spotifyTrackId: null,
    spotifyUri: null,
    trackName: event.trackName,
    artistName: event.artistName,
    primaryArtistId: null,
    albumName: event.albumName,
    albumId: null,
    isrc: null,
    trackMbid: event.trackMbid,
    artistMbid: event.artistMbid,
    albumMbid: event.albumMbid,
    playedAt: event.playedAt,
    source: "LASTFM_SCROBBLE",
    sourceEventKey: event.sourceEventKey,
    contextType: null,
    contextUri: null,
    metadata: {
      lastFmUrl: event.lastFmUrl,
      loved: event.loved,
    } as Prisma.InputJsonValue,
  };
}

function wholeSecond(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}
