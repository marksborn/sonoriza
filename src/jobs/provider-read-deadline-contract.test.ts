import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ProviderReadTimeoutError,
  withProviderReadDeadline,
} from "@/services/provider-read-deadline";

test("#435 Gate 3D provider deadline aborts a stuck external read", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    withProviderReadDeadline(
      {
        provider: "google-calendar",
        operation: "test-read",
        timeoutMs: 20,
      },
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderReadTimeoutError);
      assert.equal(error.provider, "google-calendar");
      assert.equal(error.operation, "test-read");
      assert.equal(error.timeoutMs, 20);
      assert.equal(error.code, "PROVIDER_READ_TIMEOUT");
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 2_000);
});

test("#435 Gate 3D bounds generation-path Spotify and Google provider reads", () => {
  const spotifyRequest = readFileSync("src/services/spotify/request.ts", "utf8");
  const googleClient = readFileSync("src/services/google-calendar/client.ts", "utf8");
  const googleToken = readFileSync("src/services/google-calendar/token.ts", "utf8");
  const spotifyToken = readFileSync("src/services/spotify/token.ts", "utf8");
  const recent = readFileSync("src/services/spotify/recently-played.ts", "utf8");
  const album = readFileSync("src/services/spotify/album-catalog.ts", "utf8");
  const catalog = readFileSync("src/services/spotify/catalog-search.ts", "utf8");
  const generation = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");

  assert.match(
    spotifyRequest,
    /if \(input\.method !== "GET"\)[\s\S]*?return execute\([\s\S]*?withProviderReadDeadline/,
  );
  assert.match(spotifyRequest, /kind: "READ_TIMEOUT"/);
  assert.match(spotifyRequest, /reason: "READ_TIMEOUT"/);
  assert.match(spotifyRequest, /retryable: true/);

  assert.match(
    googleClient,
    /withProviderReadDeadline\([\s\S]*?provider: "google-calendar"[\s\S]*?signal/,
  );
  assert.match(
    googleToken,
    /withProviderReadDeadline\([\s\S]*?operation: "oauth-token-refresh"/,
  );
  assert.match(
    spotifyToken,
    /withProviderReadDeadline\([\s\S]*?operation: "oauth-token-refresh"/,
  );

  assert.match(recent, /spotifyRequestAttempt/);
  assert.match(album, /spotifyRequestAttempt/);
  assert.match(catalog, /spotifyRequestAttempt/);

  assert.match(
    generation,
    /failure\.errorKind === "READ_TIMEOUT"[\s\S]*?return "PROVIDER_TIMEOUT"/,
  );
  assert.match(
    generation,
    /uma leitura do Spotify excedeu o deadline configurado e foi cancelada/,
  );
});
