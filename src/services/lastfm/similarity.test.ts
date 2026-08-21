import assert from "node:assert/strict";
import test from "node:test";

import { LastFmSimilarityClient } from "./similarity";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("artist similarity is read-only, normalized and requests autocorrect", async () => {
  let requestedUrl = "";
  let requestedUserAgent = "";
  const client = new LastFmSimilarityClient({
    apiKey: "test-key",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedUserAgent = new Headers(init?.headers).get("user-agent") ?? "";
      return jsonResponse({
        similarartists: {
          artist: [
            {
              name: "Sevendust",
              mbid: "artist-mbid",
              match: "0.92",
              url: "https://www.last.fm/music/Sevendust",
            },
            { name: "", match: "0.5" },
          ],
        },
      });
    },
  });

  const rows = await client.getSimilarArtists({
    artistName: "Mudvayne",
    artistMbid: "seed-mbid",
    limit: 15,
  });

  assert.deepEqual(rows, [
    {
      name: "Sevendust",
      mbid: "artist-mbid",
      match: 0.92,
      url: "https://www.last.fm/music/Sevendust",
    },
  ]);
  assert.match(requestedUserAgent, /^Sonoriza\/0\.1 DISCOVERY-01/);
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("method"), "artist.getsimilar");
  assert.equal(url.searchParams.get("artist"), "Mudvayne");
  assert.equal(url.searchParams.get("mbid"), "seed-mbid");
  assert.equal(url.searchParams.get("autocorrect"), "1");
  assert.equal(url.searchParams.get("limit"), "15");
  assert.equal(url.searchParams.get("api_key"), "test-key");
  assert.equal(url.searchParams.get("format"), "json");
});

test("track similarity accepts current 0..1 and legacy percentage-like match values", async () => {
  const client = new LastFmSimilarityClient({
    apiKey: "test-key",
    fetchImpl: async () =>
      jsonResponse({
        similartracks: {
          track: [
            {
              name: "Down With the Sickness",
              mbid: "track-a",
              match: 1,
              artist: { name: "Disturbed", mbid: "artist-a" },
            },
            {
              name: "Legacy Match",
              match: "10.95",
              artist: { name: "Legacy Artist" },
            },
          ],
        },
      }),
  });

  const rows = await client.getSimilarTracks({
    artistName: "Disturbed",
    trackName: "Stricken",
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.match, 1);
  assert.equal(rows[0]?.artistName, "Disturbed");
  assert.ok(Math.abs((rows[1]?.match ?? 0) - 0.1095) < 1e-12);
});

test("similarity client validates bounded result size before calling provider", async () => {
  let calls = 0;
  const client = new LastFmSimilarityClient({
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });

  await assert.rejects(
    client.getSimilarArtists({ artistName: "Artist", limit: 101 }),
    /between 1 and 100/,
  );
  assert.equal(calls, 0);
});

test("similarity client surfaces Last.fm provider errors", async () => {
  const client = new LastFmSimilarityClient({
    apiKey: "bad-key",
    fetchImpl: async () =>
      jsonResponse({ error: 29, message: "Rate limit exceeded" }, 429),
  });

  await assert.rejects(
    client.getSimilarArtists({ artistName: "Artist" }),
    /Last\.fm API error 29: Rate limit exceeded/,
  );
});
