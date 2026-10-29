import assert from "node:assert/strict";
import test from "node:test";

import { appVersion } from "./app-version";

test("build identity exposes version, short SHA and dates", () => {
  const version = appVersion({
    SONORIZA_VERSION: "0.1.0",
    SONORIZA_BUILD_SHA: "0E0821EB0CD0743D60D7E2124ADD20894627279E",
    SONORIZA_COMMIT_DATE: "2026-10-29T17:40:00-03:00",
    SONORIZA_BUILD_TIME: "2026-10-29T20:50:00.000Z",
  });
  assert.equal(version.version, "0.1.0");
  assert.equal(version.sha, "0e0821eb0cd0743d60d7e2124add20894627279e");
  assert.equal(version.shortSha, "0e0821e");
  assert.equal(version.commitDate?.toISOString(), "2026-10-29T20:40:00.000Z");
  assert.equal(version.buildTime?.toISOString(), "2026-10-29T20:50:00.000Z");
});

test("missing or malformed build identity degrades to dev", () => {
  const version = appVersion({
    SONORIZA_BUILD_SHA: "not-a-sha; rm -rf",
    SONORIZA_COMMIT_DATE: "yesterday",
  });
  assert.deepEqual(version, {
    version: "dev",
    sha: null,
    shortSha: null,
    commitDate: null,
    buildTime: null,
  });
});
