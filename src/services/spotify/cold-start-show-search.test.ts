import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeShowSearchResponse,
  normalizeSpotifyShow,
  spotifyShowSearchPath,
} from "./cold-start-show-search";

const SHOW_ID = "0123456789012345678901";

test("#473 Gate B uses only bounded Spotify show search and encodes pt-BR queries", () => {
  const path = spotifyShowSearchPath({ query: "  história  do   Brasil ", limit: 50 });
  const parsed = new URL("https://api.spotify.com/v1" + path);
  assert.equal(parsed.pathname, "/v1/search");
  assert.equal(parsed.searchParams.get("q"), "história do Brasil");
  assert.equal(parsed.searchParams.get("type"), "show");
  assert.equal(parsed.searchParams.get("market"), "BR");
  assert.equal(parsed.searchParams.get("limit"), "10");
  assert.throws(() => spotifyShowSearchPath({ query: "  " }));
  assert.throws(() => spotifyShowSearchPath({ query: "podcast", market: "invalid" }));
});

test("#473 Gate B only returns valid, unique Spotify shows and never fabricates IDs", () => {
  const page = normalizeShowSearchResponse({
    shows: { items: [
      { id: SHOW_ID, name: "Ciência e História", publisher: "Editora",
        languages: ["pt", "en"], total_episodes: 41 },
      { id: SHOW_ID, name: "Repeated" },
      { id: "invalid", name: "Unknown" },
      { id: "1234567890123456789012", name: "" },
    ] },
  });
  assert.equal(page.length, 1);
  assert.deepEqual(page[0], {
    id: SHOW_ID,
    name: "Ciência e História",
    publisher: "Editora",
    description: null,
    languages: ["pt", "en"],
    totalEpisodes: 41,
    spotifyUrl: "https://open.spotify.com/show/" + SHOW_ID,
  });
  assert.equal(normalizeSpotifyShow(null), null);
  assert.deepEqual(normalizeShowSearchResponse({ shows: { items: null } }), []);
});
