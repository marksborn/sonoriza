export type ListeningEvidenceLevel = "FACTUAL" | "INFERRED";

export type ListeningProgressStatus =
  | "COMPLETED"
  | "PARTIAL"
  | "INCONCLUSIVE";

export type ListeningEvidenceBasis =
  | "SPOTIFY_EXTENDED_HISTORY"
  | "SPOTIFY_RECENTLY_PLAYED_SEQUENCE"
  | "PODCAST_PROVIDER_RESUME_POINT"
  | "PODCAST_SESSION_SEQUENCE";

export type ListeningProgressEvidence = {
  level: ListeningEvidenceLevel;
  basis: ListeningEvidenceBasis;
  listenedMs: number;
  durationMs: number | null;
  remainingMs: number | null;
  progressRatio: number | null;
  status: ListeningProgressStatus;
};

const COMPLETION_TOLERANCE_MS = 5_000;
const MAX_SEQUENCE_SLACK_MS = 90_000;
const MIN_SEQUENCE_GAP_MS = 1_000;

/**
 * HISTORY-04 Gate 3A trust contract.
 *
 * Facts always win over inference. Consumers may use an inferred value only
 * when factual playback evidence for the same observation is unavailable.
 */
export function preferFactualEvidence(
  factual: ListeningProgressEvidence | null,
  inferred: ListeningProgressEvidence | null,
): ListeningProgressEvidence | null {
  return factual ?? inferred;
}

/**
 * Reads factual Spotify Extended Streaming History evidence already persisted
 * on TrackListeningEvent.metadata. No provider call is performed here.
 */
export function readFactualMusicEvidence(
  metadata: unknown,
  durationMs: number | null = null,
): ListeningProgressEvidence | null {
  const extended = objectAt(metadata, "spotifyExtendedHistory");
  if (!extended) return null;

  const msPlayed = nonNegativeInteger(extended.msPlayed);
  if (msPlayed === null) return null;

  const knownDuration = positiveInteger(durationMs);
  const explicitCompleted =
    extended.reasonEnd === "trackdone" && extended.explicitSkip !== true;
  const completedByDuration =
    knownDuration !== null &&
    msPlayed >= Math.max(0, knownDuration - COMPLETION_TOLERANCE_MS);
  const status: ListeningProgressStatus =
    explicitCompleted || completedByDuration
      ? "COMPLETED"
      : msPlayed > 0
        ? "PARTIAL"
        : "INCONCLUSIVE";

  return buildEvidence({
    level: "FACTUAL",
    basis: "SPOTIFY_EXTENDED_HISTORY",
    listenedMs: msPlayed,
    durationMs: knownDuration,
    status,
  });
}

/** Duration captured for new Recently Played observations without extra API. */
export function readRecentlyPlayedDurationMs(metadata: unknown): number | null {
  const recent = objectAt(metadata, "spotifyRecentlyPlayed");
  return recent ? positiveInteger(recent.trackDurationMs) : null;
}

/**
 * Infers music progress from two consecutive playback observations.
 *
 * The inference is intentionally bounded. A very large gap is not interpreted
 * as a full listen because playback may have been paused/stopped. The newest
 * observation, which has no following anchor, therefore remains inconclusive.
 */
export function inferMusicEvidenceFromSequence(input: {
  playedAt: Date;
  nextPlayedAt: Date | null;
  durationMs: number | null;
  maxSequenceSlackMs?: number;
}): ListeningProgressEvidence | null {
  const durationMs = positiveInteger(input.durationMs);
  if (!durationMs || !input.nextPlayedAt) return null;

  const gapMs = input.nextPlayedAt.getTime() - input.playedAt.getTime();
  if (!Number.isFinite(gapMs) || gapMs < MIN_SEQUENCE_GAP_MS) return null;

  const maxSlack = Math.max(
    0,
    Math.trunc(input.maxSequenceSlackMs ?? MAX_SEQUENCE_SLACK_MS),
  );
  if (gapMs > durationMs + maxSlack) return null;

  const listenedMs = Math.min(durationMs, gapMs);
  const status: ListeningProgressStatus =
    listenedMs >= Math.max(0, durationMs - COMPLETION_TOLERANCE_MS)
      ? "COMPLETED"
      : "PARTIAL";

  return buildEvidence({
    level: "INFERRED",
    basis: "SPOTIFY_RECENTLY_PLAYED_SEQUENCE",
    listenedMs,
    durationMs,
    status,
  });
}

/**
 * Converts Spotify's episode resume_point into factual podcast evidence.
 * resumePositionMs is provider-observed progress; it is never relabelled as an
 * inference merely because the Sonoriza stores it canonically.
 */
export function readFactualPodcastEvidence(input: {
  durationMs: number;
  resumePositionMs: number;
  fullyPlayed: boolean;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
}): ListeningProgressEvidence {
  const durationMs = Math.max(0, Math.trunc(input.durationMs));
  const resumePositionMs = clamp(
    Math.trunc(input.resumePositionMs),
    0,
    durationMs,
  );
  const listenedMs =
    input.fullyPlayed || input.status === "COMPLETED"
      ? durationMs
      : resumePositionMs;
  const status: ListeningProgressStatus =
    input.fullyPlayed || input.status === "COMPLETED"
      ? "COMPLETED"
      : listenedMs > 0
        ? "PARTIAL"
        : "INCONCLUSIVE";

  return buildEvidence({
    level: "FACTUAL",
    basis: "PODCAST_PROVIDER_RESUME_POINT",
    listenedMs,
    durationMs,
    status,
  });
}

/**
 * Fallback for a playback provider that cannot expose current podcast progress.
 * It advances a known resume position only when another observation provides a
 * bounded temporal anchor. This preserves remaining time instead of turning a
 * partially heard episode into COMPLETED by assumption.
 */
export function inferPodcastContinuationFromSequence(input: {
  durationMs: number;
  resumePositionMs: number;
  sessionStartedAt: Date;
  nextObservedAt: Date | null;
  maxSequenceSlackMs?: number;
}): ListeningProgressEvidence | null {
  const durationMs = positiveInteger(input.durationMs);
  if (!durationMs || !input.nextObservedAt) return null;

  const resumePositionMs = clamp(
    Math.trunc(input.resumePositionMs),
    0,
    durationMs,
  );
  const remainingBeforeSession = durationMs - resumePositionMs;
  if (remainingBeforeSession <= 0) {
    return buildEvidence({
      level: "INFERRED",
      basis: "PODCAST_SESSION_SEQUENCE",
      listenedMs: durationMs,
      durationMs,
      status: "COMPLETED",
    });
  }

  const elapsedMs =
    input.nextObservedAt.getTime() - input.sessionStartedAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_SEQUENCE_GAP_MS) return null;

  const maxSlack = Math.max(
    0,
    Math.trunc(input.maxSequenceSlackMs ?? MAX_SEQUENCE_SLACK_MS),
  );
  if (elapsedMs > remainingBeforeSession + maxSlack) return null;

  const listenedMs = Math.min(
    durationMs,
    resumePositionMs + Math.min(elapsedMs, remainingBeforeSession),
  );
  const status: ListeningProgressStatus =
    listenedMs >= Math.max(0, durationMs - COMPLETION_TOLERANCE_MS)
      ? "COMPLETED"
      : "PARTIAL";

  return buildEvidence({
    level: "INFERRED",
    basis: "PODCAST_SESSION_SEQUENCE",
    listenedMs,
    durationMs,
    status,
  });
}

function buildEvidence(input: {
  level: ListeningEvidenceLevel;
  basis: ListeningEvidenceBasis;
  listenedMs: number;
  durationMs: number | null;
  status: ListeningProgressStatus;
}): ListeningProgressEvidence {
  const listenedMs = Math.max(0, Math.trunc(input.listenedMs));
  const durationMs = positiveInteger(input.durationMs);
  const boundedListenedMs =
    durationMs === null ? listenedMs : Math.min(listenedMs, durationMs);

  return {
    level: input.level,
    basis: input.basis,
    listenedMs: boundedListenedMs,
    durationMs,
    remainingMs:
      durationMs === null ? null : Math.max(0, durationMs - boundedListenedMs),
    progressRatio:
      durationMs === null || durationMs === 0
        ? null
        : boundedListenedMs / durationMs,
    status: input.status,
  };
}

function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  return nested as Record<string, unknown>;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
