/**
 * AUDIOBOOK-02 / Gate A (#489): read-only, pure virtual-duration calculation.
 *
 * The entire audiobook remains an opaque, manually managed Spotify playlist
 * item. These values are for Sonoriza planning previews only. This module
 * cannot control playback, identify remote null items, or write playlists.
 */

export type AudiobookChapterPlanningSelection =
  | Readonly<{ mode: "FULL_CHAPTER" }>
  | Readonly<{ mode: "MANUAL_REMAINDER"; consumedMs: number }>;

export type AudiobookVirtualDurationInput = Readonly<{
  spotifyPlaylistId: string;
  spotifyAudiobookId: string;
  selectedChapterId: string;
  /** Sonoriza's planning budget; not a Spotify playback timer. */
  targetDurationMs: number;
  /** duration_ms of the explicitly selected chapter, from Spotify's chapter GET. */
  chapterDurationMs: number;
  /** Duration of the entire book for display only; never used in arithmetic. */
  providerDurationMs?: number | null;
  /** Explicit selection: start at chapter beginning or use manually entered progress. */
  selection: AudiobookChapterPlanningSelection;
}>;

export type AudiobookVirtualDurationBlockReason =
  | "INVALID_INPUT"
  | "MISSING_PLAYLIST_ID"
  | "MISSING_AUDIOBOOK_ID"
  | "MISSING_CHAPTER_ID"
  | "INVALID_TARGET_DURATION"
  | "INVALID_CHAPTER_DURATION"
  | "INVALID_PROVIDER_DURATION"
  | "INVALID_SELECTION"
  | "INVALID_MANUAL_PROGRESS"
  | "CHAPTER_ALREADY_FINISHED"
  | "CHAPTER_EXCEEDS_TARGET";

export type AudiobookVirtualDurationResult =
  | Readonly<{
      status: "BLOCKED";
      reason: AudiobookVirtualDurationBlockReason;
    }>
  | Readonly<{
      status: "READY";
      spotifyPlaylistId: string;
      spotifyAudiobookId: string;
      selectedChapterId: string;
      planningMode: AudiobookChapterPlanningSelection["mode"];
      targetDurationMs: number;
      /** Entire-book duration, if provided; informational only. */
      providerDurationMs: number | null;
      chapterDurationMs: number;
      /** Progress is locally declared, never inferred from Spotify playback. */
      manualConsumedMs: number;
      effectivePlanningDurationMs: number;
      remainingPlanningDurationMs: number;
      manualSpotifyControlRequired: true;
    }>;

function isPositiveMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function blocked(reason: AudiobookVirtualDurationBlockReason): AudiobookVirtualDurationResult {
  return { status: "BLOCKED", reason };
}

/**
 * Fail closed if any value needed for a trustworthy preview is ambiguous.
 * It does NOT create a MUSIC/PODCAST Candidate or touch PlanResult/Spotify.
 */
export function calculateAudiobookVirtualDuration(
  input: AudiobookVirtualDurationInput,
): AudiobookVirtualDurationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return blocked("INVALID_INPUT");
  }

  if (!validId(input.spotifyPlaylistId)) return blocked("MISSING_PLAYLIST_ID");
  if (!validId(input.spotifyAudiobookId)) return blocked("MISSING_AUDIOBOOK_ID");
  if (!validId(input.selectedChapterId)) return blocked("MISSING_CHAPTER_ID");
  if (!isPositiveMs(input.targetDurationMs)) return blocked("INVALID_TARGET_DURATION");
  if (!isPositiveMs(input.chapterDurationMs)) return blocked("INVALID_CHAPTER_DURATION");

  const providerDurationMs = input.providerDurationMs ?? null;
  if (providerDurationMs !== null && !isPositiveMs(providerDurationMs)) {
    return blocked("INVALID_PROVIDER_DURATION");
  }

  const selection: unknown = input.selection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return blocked("INVALID_SELECTION");
  }
  const chosen = selection as Record<string, unknown>;
  let consumedMs = 0;
  if (chosen.mode === "FULL_CHAPTER") {
    // A supplied progress contradicts this explicit whole-chapter choice.
    if ("consumedMs" in chosen) return blocked("INVALID_SELECTION");
  } else if (chosen.mode === "MANUAL_REMAINDER") {
    if (!isNonNegativeMs(chosen.consumedMs)) return blocked("INVALID_MANUAL_PROGRESS");
    if (chosen.consumedMs > input.chapterDurationMs) return blocked("INVALID_MANUAL_PROGRESS");
    if (chosen.consumedMs === input.chapterDurationMs) {
      return blocked("CHAPTER_ALREADY_FINISHED");
    }
    consumedMs = chosen.consumedMs;
  } else {
    return blocked("INVALID_SELECTION");
  }

  const effectivePlanningDurationMs = input.chapterDurationMs - consumedMs;
  // Never silently truncate an overlong chapter or invent a negative budget.
  if (effectivePlanningDurationMs > input.targetDurationMs) {
    return blocked("CHAPTER_EXCEEDS_TARGET");
  }

  return {
    status: "READY",
    spotifyPlaylistId: input.spotifyPlaylistId.trim(),
    spotifyAudiobookId: input.spotifyAudiobookId.trim(),
    selectedChapterId: input.selectedChapterId.trim(),
    planningMode: chosen.mode as AudiobookChapterPlanningSelection["mode"],
    targetDurationMs: input.targetDurationMs,
    providerDurationMs,
    chapterDurationMs: input.chapterDurationMs,
    manualConsumedMs: consumedMs,
    effectivePlanningDurationMs,
    remainingPlanningDurationMs: input.targetDurationMs - effectivePlanningDurationMs,
    manualSpotifyControlRequired: true,
  };
}
