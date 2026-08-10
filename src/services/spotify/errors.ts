import { recordSpotifyBackoff } from "./backoff";

export type SpotifyApiErrorKind =
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "HTTP_ERROR";

export type SpotifyOperation =
  | "playlist-items"
  | "playlist-metadata"
  | "show-episodes"
  | "saved-episodes"
  | "recently-played"
  | "user-playlists"
  | "saved-shows"
  | "current-user"
  | "playlist-write"
  | "spotify-api";

export interface SpotifySourceReadMetrics {
  pagesRead: number;
  cacheHits: number;
  cacheMisses: number;
  snapshotUnchanged: number;
  snapshotChanged: number;
  memoizedHits: number;
  cacheWrites: number;
  cacheWriteFailures: number;
}

export interface SpotifyRequestMetrics {
  totalCalls: number;
  callsByOperation: Record<string, number>;
  rateLimitedCount: number;
  quotaExceededCount: number;
  retries: number;
  retryWaitMs: number;
  circuitOpenSkips: number;
  cacheHits: number;
  cacheMisses: number;
  memoizedReadHits: number;
  sourceReads: Record<string, SpotifySourceReadMetrics>;
}

export class SpotifyApiError extends Error {
  readonly kind: SpotifyApiErrorKind;
  readonly status: number;
  readonly method: string;
  readonly operation: SpotifyOperation;
  readonly reason: string | null;
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;

  constructor(input: {
    kind: SpotifyApiErrorKind;
    status: number;
    method: string;
    operation: SpotifyOperation;
    reason?: string | null;
    retryAfterSeconds?: number | null;
    retryable: boolean;
    message: string;
  }) {
    super(input.message);
    this.name = "SpotifyApiError";
    this.kind = input.kind;
    this.status = input.status;
    this.method = input.method;
    this.operation = input.operation;
    this.reason = input.reason ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
    this.retryable = input.retryable;
  }
}

export function isSpotifyApiError(error: unknown): error is SpotifyApiError {
  return error instanceof SpotifyApiError;
}

export async function spotifyApiErrorFromResponse(
  response: Response,
  input: { method: string; operation: SpotifyOperation },
): Promise<SpotifyApiError> {
  const payload = await readSpotifyErrorPayload(response);
  const reason = payload.reason;
  const retryAfterSeconds = parseRetryAfterSeconds(
    response.headers.get("retry-after"),
  );

  const kind: SpotifyApiErrorKind =
    response.status === 429
      ? reason === "QUOTA_EXCEEDED"
        ? "QUOTA_EXCEEDED"
        : "RATE_LIMITED"
      : "HTTP_ERROR";

  let message: string;
  if (kind === "QUOTA_EXCEEDED") {
    message = `Spotify API quota exceeded while reading ${input.operation} (${response.status})`;
  } else if (kind === "RATE_LIMITED") {
    message = `Spotify API ${input.operation} was rate limited (${response.status})`;
  } else {
    const providerMessage = payload.message ? `: ${payload.message}` : "";
    message = `Spotify API ${input.method} ${input.operation} failed (${response.status})${providerMessage}`;
  }

  const error = new SpotifyApiError({
    kind,
    status: response.status,
    method: input.method,
    operation: input.operation,
    reason,
    retryAfterSeconds,
    retryable: kind === "RATE_LIMITED" || response.status >= 500,
    message,
  });

  // SPOTIFY-02: Retry-After is an app-wide provider contract, not just a hint
  // for the current request. Persist it before returning the error so every
  // subsequent product action/cron can fail locally without another API call.
  if (
    (kind === "QUOTA_EXCEEDED" || kind === "RATE_LIMITED") &&
    retryAfterSeconds !== null &&
    retryAfterSeconds > 0
  ) {
    await recordSpotifyBackoff({
      reason: kind,
      operation: input.operation,
      retryAfterSeconds,
    });
  }

  return error;
}

export function inferSpotifyOperation(
  path: string,
  method: string,
): SpotifyOperation {
  const normalizedMethod = method.toUpperCase();

  if (/^\/playlists\/[^/]+\/items(?:\?|$)/.test(path)) {
    return normalizedMethod === "GET" ? "playlist-items" : "playlist-write";
  }
  if (/^\/playlists\/[^/?]+(?:\?|$)/.test(path)) return "playlist-metadata";
  if (/^\/shows\/[^/]+\/episodes(?:\?|$)/.test(path)) return "show-episodes";
  if (/^\/me\/episodes(?:\?|$)/.test(path)) return "saved-episodes";
  if (/^\/me\/player\/recently-played(?:\?|$)/.test(path)) return "recently-played";
  if (/^\/me\/shows(?:\?|$)/.test(path)) return "saved-shows";
  if (/^\/me\/playlists(?:\?|$)/.test(path)) {
    return normalizedMethod === "GET" ? "user-playlists" : "playlist-write";
  }
  if (path === "/me" || path.startsWith("/me?")) return "current-user";
  return "spotify-api";
}

export function parseRetryAfterSeconds(
  value: string | null,
  nowMs = Date.now(),
): number | null {
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
}

async function readSpotifyErrorPayload(
  response: Response,
): Promise<{ reason: string | null; message: string | null }> {
  const raw = await response.text();
  if (!raw) return { reason: null, message: null };

  try {
    const parsed = JSON.parse(raw) as {
      reason?: unknown;
      message?: unknown;
      error?: {
        reason?: unknown;
        message?: unknown;
      };
    };
    const reason =
      typeof parsed.error?.reason === "string"
        ? parsed.error.reason
        : typeof parsed.reason === "string"
          ? parsed.reason
          : null;
    const message =
      typeof parsed.error?.message === "string"
        ? parsed.error.message
        : typeof parsed.message === "string"
          ? parsed.message
          : null;
    return { reason, message };
  } catch {
    return { reason: null, message: null };
  }
}