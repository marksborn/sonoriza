import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCOVERY_EXTERNAL_DATA_POLICY_ERROR_CODE,
  DiscoveryExternalDataPolicyError,
  resolveRuntimeExternalDiscovery,
} from "./external-discovery-runtime";

test("Gate 5A external discovery fails before provider/profile acquisition", async () => {
  const previousLastFmKey = process.env.LASTFM_API_KEY;
  delete process.env.LASTFM_API_KEY;

  try {
    await assert.rejects(
      () =>
        resolveRuntimeExternalDiscovery({
          userId: "user-1",
          asOf: new Date("2026-09-02T12:00:00.000Z"),
        }),
      (error: unknown) => {
        assert.ok(error instanceof DiscoveryExternalDataPolicyError);
        assert.equal(error.code, DISCOVERY_EXTERNAL_DATA_POLICY_ERROR_CODE);
        assert.match(error.message, /Spotify-derived recommendation is DENY/);
        assert.match(error.message, /Last\.fm remains REVIEW_REQUIRED/);
        return true;
      },
    );
  } finally {
    if (previousLastFmKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = previousLastFmKey;
  }
});
