import {
  LASTFM_RECENT_TRACKS_MAX_LIMIT,
  LastFmClient,
  type LastFmListeningEventInput,
  type LastFmUserProfile,
} from "./client";

const LASTFM_TRANSIENT_MAX_ATTEMPTS = 3;
const LASTFM_TRANSIENT_RETRY_BASE_DELAY_MS = 1_000;

export type LastFmBackfillCheckpoint = {
  username: string;
  from: Date | null;
  to: Date;
  nextPage: number;
  totalPages: number | null;
  scannedProviderRows: number;
  acceptedEvents: number;
  nowPlayingSkipped: number;
  invalidSkipped: number;
};

export type LastFmBackfillPage = {
  checkpointBefore: LastFmBackfillCheckpoint;
  checkpointAfter: LastFmBackfillCheckpoint;
  events: LastFmListeningEventInput[];
};

export type LastFmBackfillResult = {
  profile: LastFmUserProfile;
  checkpoint: LastFmBackfillCheckpoint;
  completed: boolean;
};

export type LastFmBackfillOptions = {
  client: LastFmClient;
  username: string;
  /** Freeze the upper boundary so new scrobbles cannot shift pagination. */
  to?: Date;
  /** Usually the account registration time; null means provider's full history. */
  from?: Date | null;
  checkpoint?: LastFmBackfillCheckpoint | null;
  maxPages?: number;
  /** Delay between provider pages. Orchestration sets a conservative default. */
  pageDelayMs?: number;
  onPage: (page: LastFmBackfillPage) => Promise<void> | void;
};

/**
 * Scans Last.fm history without holding the whole account in memory.
 *
 * `to` is fixed for the entire import. This is important because Last.fm pages
 * recent tracks newest-first; without a frozen upper bound, new scrobbles could
 * move page boundaries during a multi-page import. The caller persists the
 * returned checkpoint after each successful `onPage`, making the scan resumable.
 *
 * Provider errors 8/11/16 and HTTP 5xx are treated as transient. Each individual
 * read gets at most three attempts with a small linear backoff. Configuration,
 * authentication and rate-limit errors fail immediately.
 */
export async function scanLastFmBackfill(
  options: LastFmBackfillOptions,
): Promise<LastFmBackfillResult> {
  const username = options.username.trim();
  if (!username) throw new Error("Last.fm username is required");
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  if (!(maxPages > 0)) throw new Error("maxPages must be positive");
  const pageDelayMs = options.pageDelayMs ?? 0;
  if (!Number.isFinite(pageDelayMs) || pageDelayMs < 0) {
    throw new Error("pageDelayMs must be a non-negative finite number");
  }

  const profile = await withLastFmTransientRetry(() =>
    options.client.getUserInfo(username),
  );
  let checkpoint = options.checkpoint
    ? validateCheckpoint(options.checkpoint, username)
    : initialCheckpoint({
        username: profile.username || username,
        from: options.from ?? profile.registeredAt,
        to: options.to ?? new Date(),
      });

  let pagesProcessed = 0;
  while (
    pagesProcessed < maxPages &&
    (checkpoint.totalPages === null || checkpoint.nextPage <= checkpoint.totalPages)
  ) {
    if (pagesProcessed > 0 && pageDelayMs > 0) {
      await sleep(pageDelayMs);
    }

    const before = cloneCheckpoint(checkpoint);
    const page = await withLastFmTransientRetry(() =>
      options.client.getRecentTracksPage({
        username: checkpoint.username,
        page: checkpoint.nextPage,
        limit: LASTFM_RECENT_TRACKS_MAX_LIMIT,
        from: checkpoint.from ?? undefined,
        to: checkpoint.to,
      }),
    );

    const totalPages = checkpoint.totalPages ?? page.totalPages;
    const scannedProviderRows =
      checkpoint.scannedProviderRows +
      page.events.length +
      page.nowPlayingCount +
      page.invalidCount;
    const after: LastFmBackfillCheckpoint = {
      ...checkpoint,
      nextPage: checkpoint.nextPage + 1,
      totalPages,
      scannedProviderRows,
      acceptedEvents: checkpoint.acceptedEvents + page.events.length,
      nowPlayingSkipped: checkpoint.nowPlayingSkipped + page.nowPlayingCount,
      invalidSkipped: checkpoint.invalidSkipped + page.invalidCount,
    };

    // The caller must persist events and checkpoint atomically when possible.
    // We only advance our in-memory checkpoint after that operation succeeds.
    await options.onPage({
      checkpointBefore: before,
      checkpointAfter: cloneCheckpoint(after),
      events: page.events,
    });
    checkpoint = after;
    pagesProcessed += 1;
  }

  return {
    profile,
    checkpoint,
    completed:
      checkpoint.totalPages !== null && checkpoint.nextPage > checkpoint.totalPages,
  };
}

export function initialCheckpoint(input: {
  username: string;
  from: Date | null;
  to: Date;
}): LastFmBackfillCheckpoint {
  if (input.from && input.from >= input.to) {
    throw new Error("Last.fm backfill 'from' must be before 'to'");
  }
  return {
    username: input.username.trim(),
    from: input.from ? new Date(input.from) : null,
    to: new Date(input.to),
    nextPage: 1,
    totalPages: null,
    scannedProviderRows: 0,
    acceptedEvents: 0,
    nowPlayingSkipped: 0,
    invalidSkipped: 0,
  };
}

export async function withLastFmTransientRetry<T>(
  operation: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? LASTFM_TRANSIENT_MAX_ATTEMPTS;
  const baseDelayMs =
    options?.baseDelayMs ?? LASTFM_TRANSIENT_RETRY_BASE_DELAY_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Last.fm retry maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error("Last.fm retry baseDelayMs must be non-negative");
  }

  let attempt = 1;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientLastFmFailure(error)) {
        throw error;
      }
      await sleep(baseDelayMs * attempt);
      attempt += 1;
    }
  }
}

export function isTransientLastFmFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /^Last\.fm API error (8|11|16):/.test(error.message) ||
    /^Last\.fm request failed with HTTP 5\d\d$/.test(error.message)
  );
}

function validateCheckpoint(
  checkpoint: LastFmBackfillCheckpoint,
  requestedUsername: string,
): LastFmBackfillCheckpoint {
  if (checkpoint.username.toLocaleLowerCase("en-US") !== requestedUsername.toLocaleLowerCase("en-US")) {
    throw new Error("Last.fm checkpoint belongs to another username");
  }
  if (!Number.isInteger(checkpoint.nextPage) || checkpoint.nextPage < 1) {
    throw new Error("Invalid Last.fm checkpoint nextPage");
  }
  if (
    checkpoint.totalPages !== null &&
    (!Number.isInteger(checkpoint.totalPages) || checkpoint.totalPages < 0)
  ) {
    throw new Error("Invalid Last.fm checkpoint totalPages");
  }
  return cloneCheckpoint(checkpoint);
}

function cloneCheckpoint(
  checkpoint: LastFmBackfillCheckpoint,
): LastFmBackfillCheckpoint {
  return {
    ...checkpoint,
    from: checkpoint.from ? new Date(checkpoint.from) : null,
    to: new Date(checkpoint.to),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
