export type ProviderReadName = "spotify" | "google-calendar";

export const DEFAULT_PROVIDER_READ_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_READ_TIMEOUT_MS = 120_000;

export class ProviderReadTimeoutError extends Error {
  readonly code = "PROVIDER_READ_TIMEOUT";

  constructor(
    readonly provider: ProviderReadName,
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(
      `${provider} ${operation} timed out after ${timeoutMs}ms`,
    );
    this.name = "ProviderReadTimeoutError";
  }
}

export function providerReadTimeoutMs(
  provider: ProviderReadName,
): number {
  const specific =
    provider === "spotify"
      ? process.env.SPOTIFY_READ_TIMEOUT_MS
      : process.env.GOOGLE_CALENDAR_READ_TIMEOUT_MS;
  const fallback = process.env.PROVIDER_READ_TIMEOUT_MS;

  for (const value of [specific, fallback]) {
    if (!value) continue;
    const parsed = Number(value);
    if (
      Number.isInteger(parsed) &&
      parsed > 0 &&
      parsed <= MAX_PROVIDER_READ_TIMEOUT_MS
    ) {
      return parsed;
    }
  }

  return DEFAULT_PROVIDER_READ_TIMEOUT_MS;
}

export async function withProviderReadDeadline<T>(
  input: {
    provider: ProviderReadName;
    operation: string;
    timeoutMs?: number;
    signal?: AbortSignal | null;
  },
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs =
    input.timeoutMs ?? providerReadTimeoutMs(input.provider);

  // Use Node's native AbortSignal timeout clock instead of the mutable global
  // setTimeout. Some generation tests intentionally replace setTimeout to
  // fast-forward Spotify Retry-After waits; the provider deadline must remain
  // a real wall-clock deadline and must not be fast-forwarded with that retry.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;

  try {
    return await work(signal);
  } catch (error) {
    if (timeoutSignal.aborted && !input.signal?.aborted) {
      throw new ProviderReadTimeoutError(
        input.provider,
        input.operation,
        timeoutMs,
      );
    }
    throw error;
  }
}
