import type { SpotifyRequestMetrics } from "@/services/spotify/errors";

export type ScheduledSpotifyPreflightPhase = "KEEP_FILLED" | "REBUILD";

export type ScheduledSpotifyPreflightTelemetry = {
  phase: ScheduledSpotifyPreflightPhase;
  elapsedMs: number;
  totalCalls: number;
  criticalGet5xxRetries: number;
  criticalGet5xxRecoveries: number;
  retryWaitMs: number;
  callsByOperation: Partial<Record<
    "playlist-metadata" | "playlist-items" | "episode-state",
    number
  >>;
};

const CRITICAL_OPERATIONS = [
  "playlist-metadata",
  "playlist-items",
  "episode-state",
] as const;

function difference(after: number | undefined, before: number | undefined): number {
  return Math.max(0, (after ?? 0) - (before ?? 0));
}

/**
 * No path, token, playlist/episode ID or per-source key is persisted.
 * Baseline metrics isolate an individual REBUILD preflight when its client is reused.
 */
export function summarizeScheduledSpotifyPreflight(input: {
  phase: ScheduledSpotifyPreflightPhase;
  startedAtMs: number;
  endedAtMs: number;
  before?: SpotifyRequestMetrics | null;
  after?: SpotifyRequestMetrics | null;
}): ScheduledSpotifyPreflightTelemetry {
  const { after, before } = input;
  const callsByOperation: ScheduledSpotifyPreflightTelemetry["callsByOperation"] = {};
  for (const operation of CRITICAL_OPERATIONS) {
    const count = difference(
      after?.callsByOperation[operation],
      before?.callsByOperation[operation],
    );
    if (count > 0) callsByOperation[operation] = count;
  }

  return {
    phase: input.phase,
    elapsedMs: Math.max(0, input.endedAtMs - input.startedAtMs),
    totalCalls: difference(after?.totalCalls, before?.totalCalls),
    criticalGet5xxRetries: difference(
      after?.criticalGet5xxRetries,
      before?.criticalGet5xxRetries,
    ),
    criticalGet5xxRecoveries: difference(
      after?.criticalGet5xxRecoveries,
      before?.criticalGet5xxRecoveries,
    ),
    retryWaitMs: difference(after?.retryWaitMs, before?.retryWaitMs),
    callsByOperation,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Keep the safe preflight evidence when lifecycle checkpoints or summaries replace details. */
export function preserveScheduledSpotifyPreflight(
  existingDetails: unknown,
  newDetails: Record<string, unknown>,
): Record<string, unknown> {
  const preflight = record(existingDetails)?.spotifyPreflight;
  if (!record(preflight) || "spotifyPreflight" in newDetails) return newDetails;
  return { ...newDetails, spotifyPreflight: preflight };
}

/** In particular, never preserve full Spotify metrics with per-source IDs. */
export function addScheduledSpotifyPreflight(
  existingDetails: unknown,
  summary: ScheduledSpotifyPreflightTelemetry,
): Record<string, unknown> {
  return {
    ...(record(existingDetails) ?? {}),
    spotifyPreflight: summary,
  };
}
