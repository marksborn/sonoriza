import type { TargetScheduleRunStatus } from "@prisma/client";

import { ProviderReadTimeoutError } from "@/services/provider-read-deadline";
import { SpotifyApiError } from "@/services/spotify/errors";

// #435 Gate 3F: a scheduled slot must not wait 30 minutes to recover from a
// failure that is known to have happened before any Spotify mutation. The
// stale RUNNING window (RETRY_AFTER_MS) stays at 30 minutes because writes are
// still unbounded; only attempts that already finished FAILED retry sooner.
export const DEFAULT_FAILED_RETRY_AFTER_MS = 5 * 60 * 1000;
const MIN_FAILED_RETRY_AFTER_MS = 60 * 1000;
const MAX_FAILED_RETRY_AFTER_MS = 30 * 60 * 1000;

export function failedRetryAfterMs(
  raw = process.env.SCHEDULE_FAILED_RETRY_AFTER_MS,
): number {
  if (!raw) return DEFAULT_FAILED_RETRY_AFTER_MS;
  const parsed = Number(raw);
  if (
    Number.isInteger(parsed) &&
    parsed >= MIN_FAILED_RETRY_AFTER_MS &&
    parsed <= MAX_FAILED_RETRY_AFTER_MS
  ) {
    return parsed;
  }
  return DEFAULT_FAILED_RETRY_AFTER_MS;
}

export function isProviderReadTimeout(error: unknown): boolean {
  if (error instanceof ProviderReadTimeoutError) return true;
  return error instanceof SpotifyApiError && error.kind === "READ_TIMEOUT";
}

/**
 * Maps a finished GenerationRun to the TargetScheduleRun status.
 *
 * A FAILED generation is normally BLOCKED (terminal for the slot): retrying a
 * deterministic failure only burns provider quota. The exception is a run that
 * explicitly recorded `retryableBeforeWrite=true`, i.e. a provider read timed
 * out before the PROVIDER_WRITE_START checkpoint. Those stay FAILED so the
 * scheduler retries the slot within MAX_SCHEDULE_ATTEMPTS.
 */
export function scheduleStatus(
  generationStatus: string,
  targetSummary: Record<string, unknown> | null,
  runSummary: unknown = null,
): TargetScheduleRunStatus {
  if (generationStatus === "SUCCESS") {
    if (targetSummary?.maintenanceNoop === true) return "NOOP";
    return "SUCCESS";
  }
  if (generationStatus === "PARTIAL") return "PARTIAL";
  if (generationStatus === "FAILED" && retryableBeforeWrite(runSummary)) {
    return "FAILED";
  }
  return "BLOCKED";
}

function retryableBeforeWrite(summary: unknown): boolean {
  return (
    !!summary &&
    typeof summary === "object" &&
    !Array.isArray(summary) &&
    (summary as Record<string, unknown>).retryableBeforeWrite === true
  );
}
