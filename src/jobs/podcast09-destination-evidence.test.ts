import assert from "node:assert/strict";
import test from "node:test";

import { podcast09DestinationEpisodeIds } from "./podcast09-destination-evidence";

test("Gate 3.2 preserves current destination podcast order", () => {
  const result = podcast09DestinationEpisodeIds([
    { type: "MUSIC", spotifyEpisodeId: null },
    { type: "PODCAST", spotifyEpisodeId: "episode-a" },
    { type: "PODCAST", spotifyEpisodeId: "episode-b" },
    { type: "MUSIC", spotifyEpisodeId: null },
    { type: "PODCAST", spotifyEpisodeId: "episode-c" },
  ]);

  assert.deepEqual(result, ["episode-a", "episode-b", "episode-c"]);
});

test("Gate 3.2 ignores non-podcast and unidentified playlist items", () => {
  const result = podcast09DestinationEpisodeIds([
    { type: "MUSIC", spotifyEpisodeId: "not-an-episode" },
    { type: "PODCAST", spotifyEpisodeId: null },
    { type: null, spotifyEpisodeId: "unknown" },
    { type: "PODCAST", spotifyEpisodeId: "episode" },
  ]);

  assert.deepEqual(result, ["episode"]);
});

test("Gate 3.2 treats an empty destination as valid empty evidence", () => {
  assert.deepEqual(podcast09DestinationEpisodeIds([]), []);
});
