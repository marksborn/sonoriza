import assert from "node:assert/strict";
import test from "node:test";

import { isSpotifyApiError } from "./errors";
import {
  asPodcastLocalProcessingError,
  diagnosePodcastListeningPersistenceError,
  readPodcastLocalProcessingReason,
} from "./podcast-listening-state-diagnostics";

test("preserves only a safe Prisma code and error class", () => {
  const error = Object.assign(
    new Error("SQL SELECT secret-token Authorization: Bearer abc"),
    {
      name: "PrismaClientKnownRequestError",
      code: "P2028",
      meta: { sql: "SELECT * FROM secret" },
    },
  );

  const diagnostic = diagnosePodcastListeningPersistenceError(error);

  assert.deepEqual(diagnostic, {
    area: "PODCAST_LISTENING_STATE",
    errorName: "PrismaClientKnownRequestError",
    errorCode: "P2028",
  });
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /secret|Authorization|Bearer|SELECT/i,
  );
});

test("reads a safe transport code from the cause without keeping messages", () => {
  const error = Object.assign(new TypeError("fetch failed with private URL"), {
    cause: Object.assign(new Error("socket details"), { code: "ECONNRESET" }),
  });

  assert.deepEqual(diagnosePodcastListeningPersistenceError(error), {
    area: "PODCAST_LISTENING_STATE",
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  });
});

test("rejects unsafe names and arbitrary error codes", () => {
  const diagnostic = diagnosePodcastListeningPersistenceError({
    name: "Error\nAuthorization: Bearer x",
    code: "postgres-password=secret",
  });

  assert.deepEqual(diagnostic, {
    area: "PODCAST_LISTENING_STATE",
    errorName: "UnknownError",
    errorCode: null,
  });
});

test("local phase error is carried by the existing source failure pipeline without secrets", () => {
  const raw = Object.assign(
    new Error("SQL SELECT Authorization: Bearer secret-token"),
    {
      name: "PrismaClientKnownRequestError",
      code: "P2028",
      meta: { sql: "SELECT private" },
    },
  );
  const error = asPodcastLocalProcessingError("OBSERVE_STATE", raw);

  assert.equal(isSpotifyApiError(error), true);
  assert.equal(error.kind, "LOCAL_PROCESSING_ERROR");
  assert.equal(error.status, 0);
  assert.equal(error.method, "LOCAL");
  assert.equal(error.operation, "observe-state");
  assert.deepEqual(readPodcastLocalProcessingReason(error.reason), {
    phase: "OBSERVE_STATE",
    errorName: "PrismaClientKnownRequestError",
    errorCode: "P2028",
  });
  assert.doesNotMatch(
    JSON.stringify({
      kind: error.kind,
      status: error.status,
      operation: error.operation,
      reason: error.reason,
    }),
    /secret-token|Authorization|SELECT private/i,
  );
});

test("wrapping a typed local error preserves the first failing phase", () => {
  const first = asPodcastLocalProcessingError(
    "OBSERVE_STATE",
    Object.assign(new Error("private"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    }),
  );
  const wrappedAgain = asPodcastLocalProcessingError("BUILD_CANDIDATES", first);

  assert.equal(wrappedAgain, first);
  assert.deepEqual(readPodcastLocalProcessingReason(wrappedAgain.reason), {
    phase: "OBSERVE_STATE",
    errorName: "PrismaClientKnownRequestError",
    errorCode: "P2002",
  });
});

test("all local phases use explicit safe operations", () => {
  const phases = [
    ["NORMALIZE_EPISODES", "normalize-episodes"],
    ["OBSERVE_STATE", "observe-state"],
    ["BUILD_CANDIDATES", "build-candidates"],
  ] as const;

  for (const [phase, operation] of phases) {
    const error = asPodcastLocalProcessingError(phase, new TypeError("private"));
    assert.equal(error.operation, operation);
    assert.equal(readPodcastLocalProcessingReason(error.reason)?.phase, phase);
  }
});