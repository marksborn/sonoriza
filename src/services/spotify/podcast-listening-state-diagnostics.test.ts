import assert from "node:assert/strict";
import test from "node:test";

import { diagnosePodcastListeningPersistenceError } from "./podcast-listening-state-diagnostics";

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
