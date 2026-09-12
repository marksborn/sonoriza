import assert from "node:assert/strict";
import test from "node:test";

import {
  onboardingTelemetryEventData,
  sanitizeOnboardingTelemetryMetadata,
} from "@/services/onboarding/telemetry";

test("Gate 8 telemetry keeps only low-cardinality safe metadata", () => {
  assert.deepEqual(
    sanitizeOnboardingTelemetryMetadata({
      code: "rate-limit",
      provider: "spotify",
      operation: "playlist-page",
      outcome: "failed",
      retryAfterSeconds: 10,
      email: "should-not-be-stored@example.com",
      spotifyPlaylistId: "secret",
      nested: {
        raw: "provider-response",
      },
    }),
    {
      code: "rate-limit",
      provider: "spotify",
      operation: "playlist-page",
      outcome: "failed",
    },
  );
});

test("Gate 8 telemetry binds event to user, version and step", () => {
  const data =
    onboardingTelemetryEventData({
      userId: "user-1",
      event: "stepFailed",
      step: "SOURCES",
      metadata: {
        code: "rate-limit",
      },
    });

  assert.equal(data.userId, "user-1");
  assert.equal(data.version, 1);
  assert.equal(data.event, "stepFailed");
  assert.equal(data.step, "SOURCES");
  assert.deepEqual(data.metadata, {
    code: "rate-limit",
  });
});

test("Gate 8 telemetry drops arbitrary provider payloads", () => {
  const data =
    onboardingTelemetryEventData({
      userId: "user-1",
      event: "firstSimulationFailed",
      step: "SIMULATION",
      metadata: {
        responseBody: "raw body",
        accessToken: "token",
        calendarName: "private",
      },
    });

  assert.equal(
    Object.prototype.hasOwnProperty.call(
      data,
      "metadata",
    ),
    false,
  );
});
