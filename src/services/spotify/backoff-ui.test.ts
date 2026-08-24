import assert from "node:assert/strict";
import test from "node:test";

import { spotifyBackoffRemainingMs } from "./backoff-ui";

test("returns remaining milliseconds for a future backoff", () => {
  const now = Date.parse("2026-08-24T08:50:00.000Z");
  assert.equal(
    spotifyBackoffRemainingMs("2026-08-24T08:51:18.712Z", now),
    78_712,
  );
});

test("returns zero when the backoff has already expired", () => {
  const now = Date.parse("2026-08-24T09:20:00.000Z");
  assert.equal(
    spotifyBackoffRemainingMs("2026-08-24T08:51:18.712Z", now),
    0,
  );
});

test("returns null for an invalid timestamp", () => {
  assert.equal(spotifyBackoffRemainingMs("not-a-date", Date.now()), null);
});
