export type PodcastListeningPersistenceDiagnostic = {
  area: "PODCAST_LISTENING_STATE";
  errorName: string;
  errorCode: string | null;
};

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
  const code = (value as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const trimmed = code.trim();

  if (/^P\d{4}$/.test(trimmed)) return trimmed;
  if (/^E[A-Z0-9_]{1,31}$/.test(trimmed)) return trimmed;
  return null;
}
