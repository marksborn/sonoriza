import {
  ProviderReadTimeoutError,
  spotifyWriteTimeoutMs,
  withProviderReadDeadline,
} from "@/services/provider-read-deadline";

import {
  SpotifyApiError,
  spotifyApiErrorFromResponse,
  type SpotifyOperation,
} from "./errors";

const API = "https://api.spotify.com/v1";

export async function spotifyRequestAttempt<T>(input: {
  accessToken: string;
  path: string;
  method: string;
  operation: SpotifyOperation;
  init?: RequestInit;
}): Promise<T> {
  const execute = async (signal?: AbortSignal): Promise<T> => {
    const response = await fetch(`${API}${input.path}`, {
      ...input.init,
      ...(signal ? { signal } : {}),
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        ...(input.init?.headers ?? {}),
      },
    });

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }

    throw await spotifyApiErrorFromResponse(response, {
      method: input.method,
      operation: input.operation,
    });
  };

  if (input.method !== "GET") {
    // #435 Gate 3H: writes are bounded too, but a timed-out write is NOT
    // retryable here: Spotify may still apply it. It surfaces as WRITE_TIMEOUT
    // (outcome unknown) so the caller re-reads the live playlist first.
    const timeoutMs = spotifyWriteTimeoutMs();
    try {
      return await withProviderReadDeadline(
        {
          provider: "spotify",
          operation: input.operation,
          timeoutMs,
          signal: input.init?.signal,
        },
        execute,
      );
    } catch (error) {
      if (error instanceof ProviderReadTimeoutError) {
        throw new SpotifyApiError({
          kind: "WRITE_TIMEOUT",
          status: 0,
          method: input.method,
          operation: input.operation,
          reason: "WRITE_TIMEOUT",
          retryable: false,
          message:
            `Spotify API ${input.method} ${input.operation} timed out after ` +
            `${timeoutMs}ms; the write outcome is unknown`,
        });
      }
      throw error;
    }
  }

  try {
    return await withProviderReadDeadline(
      {
        provider: "spotify",
        operation: input.operation,
        signal: input.init?.signal,
      },
      execute,
    );
  } catch (error) {
    if (error instanceof ProviderReadTimeoutError) {
      throw new SpotifyApiError({
        kind: "READ_TIMEOUT",
        status: 0,
        method: input.method,
        operation: input.operation,
        reason: "READ_TIMEOUT",
        retryable: true,
        message:
          `Spotify API GET ${input.operation} timed out after ` +
          `${error.timeoutMs}ms`,
      });
    }
    throw error;
  }
}
