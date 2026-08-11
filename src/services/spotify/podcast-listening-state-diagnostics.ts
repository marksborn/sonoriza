import { SpotifyApiError, type SpotifyOperation } from "./errors";

export type PodcastListeningPersistenceDiagnostic = {
  area: "PODCAST_LISTENING_STATE";
  errorName: string;
  errorCode: string | null;
};

export type PodcastLocalProcessingPhase =
  | "NORMALIZE_EPISODES"
  | "OBSERVE_STATE"
  | "BUILD_CANDIDATES";

export type PodcastLocalProcessingDiagnostic = {
  phase: PodcastLocalProcessingPhase;
  errorName: string;
  errorCode: string | null;
};

const PHASE_OPERATION: Record<PodcastLocalProcessingPhase, SpotifyOperation> = {
  NORMALIZE_EPISODES: "normalize-episodes",
  OBSERVE_STATE: "observe-state",
  BUILD_CANDIDATES: "build-candidates",
};

/**
 * Local podcast failures intentionally extend SpotifyApiError only so the
 * existing fail-safe source collection pipeline carries them to GenerationRun
 * instead of collapsing them to SOURCE_READ_FAILED. `kind`, `method`, status 0
 * and the local operations below clearly distinguish them from provider HTTP
 * failures.
 */
export class PodcastLocalProcessingError extends SpotifyApiError {
  readonly phase: PodcastLocalProcessingPhase;
  readonly errorName: string;
  readonly errorCode: string | null;

  constructor(phase: PodcastLocalProcessingPhase, error: unknown) {
    const diagnostic = diagnosePodcastListeningPersistenceError(error);
    super({
      kind: "LOCAL_PROCESSING_ERROR",
      status: 0,
      method: "LOCAL",
      operation: PHASE_OPERATION[phase],
      reason: encodePodcastLocalProcessingReason({
        phase,
        errorName: diagnostic.errorName,
        errorCode: diagnostic.errorCode,
      }),
      retryable: false,
      message: `Podcast local processing failed during ${phase}`,
    });
    this.name = "PodcastLocalProcessingError";
    this.phase = phase;
    this.errorName = diagnostic.errorName;
    this.errorCode = diagnostic.errorCode;
  }
}

export function asPodcastLocalProcessingError(
  phase: PodcastLocalProcessingPhase,
  error: unknown,
): PodcastLocalProcessingError {
  return error instanceof PodcastLocalProcessingError
    ? error
    : new PodcastLocalProcessingError(phase, error);
}

export function encodePodcastLocalProcessingReason(
  diagnostic: PodcastLocalProcessingDiagnostic,
): string {
  return [
    "LOCAL",
    diagnostic.phase,
    diagnostic.errorName,
    diagnostic.errorCode ?? "NO_CODE",
  ].join("|");
}

export function readPodcastLocalProcessingReason(
  value: unknown,
): PodcastLocalProcessingDiagnostic | null {
  if (typeof value !== "string") return null;
  const [marker, phase, errorName, rawCode, ...rest] = value.split("|");
  if (marker !== "LOCAL" || rest.length > 0) return null;
  if (
    phase !== "NORMALIZE_EPISODES" &&
    phase !== "OBSERVE_STATE" &&
    phase !== "BUILD_CANDIDATES"
  ) {
    return null;
  }
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(errorName ?? "")) return null;
  const errorCode = rawCode === "NO_CODE" ? null : safeStandaloneCode(rawCode);
  if (rawCode !== "NO_CODE" && errorCode === null) return null;
  return { phase, errorName, errorCode };
}

/**
 * Keep runtime observability useful without ever serializing an exception
 * message, SQL text, provider payload or credentials. Prisma exposes stable
 * Pxxxx codes; transport/runtime errors may expose a short uppercase code on
 * the error or its cause.
 */
export function diagnosePodcastListeningPersistenceError(
  error: unknown,
): PodcastListeningPersistenceDiagnostic {
  return {
    area: "PODCAST_LISTENING_STATE",
    errorName: safeErrorName(error),
    errorCode: safeErrorCode(error),
  };
}

function safeErrorName(error: unknown): string {
  if (!error || typeof error !== "object") return "UnknownError";
  const name = (error as { name?: unknown }).name;
  if (typeof name !== "string") return "UnknownError";
  const trimmed = name.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(trimmed)
    ? trimmed
    : "UnknownError";
}

function safeErrorCode(error: unknown): string | null {
  const direct = readCode(error);
  if (direct) return direct;

  if (error && typeof error === "object") {
    return readCode((error as { cause?: unknown }).cause);
  }
  return null;
}

function readCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return safeStandaloneCode((value as { code?: unknown }).code);
}

function safeStandaloneCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  if (/^P\d{4}$/.test(trimmed)) return trimmed;
  if (/^E[A-Z0-9_]{1,31}$/.test(trimmed)) return trimmed;
  return null;
}