import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientLastFmFailure,
  withLastFmTransientRetry,
} from "./backfill";

test("transient Last.fm API error 8 retries and succeeds within the bounded budget", async () => {
  let attempts = 0;

  const result = await withLastFmTransientRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(
          "Last.fm API error 8: Operation failed - Most likely the backend service failed. Please try again.",
        );
      }
      return "ok";
    },
    { maxAttempts: 3, baseDelayMs: 0 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("Last.fm transient classification includes API 8/11/16 and HTTP 5xx", () => {
  for (const code of [8, 11, 16]) {
    assert.equal(
      isTransientLastFmFailure(new Error(`Last.fm API error ${code}: temporary`)),
      true,
    );
  }

  assert.equal(
    isTransientLastFmFailure(new Error("Last.fm request failed with HTTP 503")),
    true,
  );
});

test("configuration and rate-limit errors fail immediately without retry", async () => {
  for (const code of [10, 29]) {
    let attempts = 0;

    await assert.rejects(
      withLastFmTransientRetry(
        async () => {
          attempts += 1;
          throw new Error(`Last.fm API error ${code}: fatal`);
        },
        { maxAttempts: 3, baseDelayMs: 0 },
      ),
      new RegExp(`Last\\.fm API error ${code}`),
    );

    assert.equal(attempts, 1);
  }
});

test("persistent transient failure stops after the configured attempt budget", async () => {
  let attempts = 0;

  await assert.rejects(
    withLastFmTransientRetry(
      async () => {
        attempts += 1;
        throw new Error("Last.fm API error 16: temporary");
      },
      { maxAttempts: 3, baseDelayMs: 0 },
    ),
    /Last\.fm API error 16/,
  );

  assert.equal(attempts, 3);
});
