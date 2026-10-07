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
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(input.signal?.reason);
  };

  if (input.signal?.aborted) {
    onExternalAbort();
  } else {
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  try {
    return await work(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new ProviderReadTimeoutError(
        input.provider,
        input.operation,
        timeoutMs,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}
