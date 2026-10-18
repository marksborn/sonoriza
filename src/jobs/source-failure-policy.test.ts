import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyApiError, type SpotifyOperation } from "@/services/spotify/errors";

import { isDegradableSpotifySourceFailure } from "./source-failure-policy";

function providerError(
  status: number,
  kind: "HTTP_ERROR" | "RATE_LIMITED" | "QUOTA_EXCEEDED",
  operation: SpotifyOperation = "show-episodes",
  method = "GET",
) {
  return new SpotifyApiError({
    kind,
    status,
    method,
    operation,
    retryable: status >= 500 || kind === "RATE_LIMITED",
    message: `provider ${status}`,
  });
}

test("isolated source-level HTTP 502 and GET 404 are degradable", () => {
  assert.equal(isDegradableSpotifySourceFailure(providerError(502, "HTTP_ERROR")), true);
  assert.equal(isDegradableSpotifySourceFailure(providerError(404, "HTTP_ERROR", "show-episodes")), true);
  assert.equal(isDegradableSpotifySourceFailure(providerError(404, "HTTP_ERROR", "playlist-items")), true);
  assert.equal(isDegradableSpotifySourceFailure(providerError(404, "HTTP_ERROR", "playlist-metadata")), true);
});

test("authentication, quota, other provider failures and non-source 404 fail closed", () => {
  assert.equal(isDegradableSpotifySourceFailure(providerError(503, "HTTP_ERROR")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(401, "HTTP_ERROR")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(403, "HTTP_ERROR")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(429, "RATE_LIMITED")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(429, "QUOTA_EXCEEDED")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(404, "HTTP_ERROR", "saved-episodes")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(404, "HTTP_ERROR", "spotify-api")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(404, "HTTP_ERROR", "playlist-write", "POST")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(404, "HTTP_ERROR", "show-episodes", "POST")), false);
  assert.equal(isDegradableSpotifySourceFailure(new Error("local")), false);
});
