import assert from "node:assert/strict";
import test from "node:test";

import { inferSpotifyOperation } from "./errors";

test("GET /episodes/{id} is classified as episode-state", () => {
  assert.equal(
    inferSpotifyOperation("/episodes/episode-123?market=from_token", "GET"),
    "episode-state",
  );
});

test("show and saved episode endpoints keep their existing classifications", () => {
  assert.equal(
    inferSpotifyOperation("/shows/show-123/episodes?limit=50", "GET"),
    "show-episodes",
  );
  assert.equal(
    inferSpotifyOperation("/me/episodes?limit=50", "GET"),
    "saved-episodes",
  );
});
