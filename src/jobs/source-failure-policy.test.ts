import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyApiError } from "@/services/spotify/errors";

import { isDegradableSpotifySourceFailure } from "./source-failure-policy";

function providerError(
  status: number,
  kind: "HTTP_ERROR" | "RATE_LIMITED" | "QUOTA_EXCEEDED",
) {
  return new SpotifyApiError({
    kind,
    status,
    method: "GET",
    operation: "show-episodes",
    retryable: status >= 500 || kind === "RATE_LIMITED",
    message: `provider ${status}`,
  });
}

test("only an isolated Spotify HTTP 502 source failure is degradable", () => {
  assert.equal(isDegradableSpotifySourceFailure(providerError(502, "HTTP_ERROR")), true);
  assert.equal(isDegradableSpotifySourceFailure(providerError(503, "HTTP_ERROR")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(429, "RATE_LIMITED")), false);
  assert.equal(isDegradableSpotifySourceFailure(providerError(429, "QUOTA_EXCEEDED")), false);
  assert.equal(isDegradableSpotifySourceFailure(new Error("local")), false);
});
