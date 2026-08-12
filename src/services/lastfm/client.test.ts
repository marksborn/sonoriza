import assert from "node:assert/strict";
import test from "node:test";

import {
  LASTFM_RECENT_TRACKS_MAX_LIMIT,
  LastFmClient,
  lastFmSourceEventKey,
  mapRecentTrackToListeningEvent,
} from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("maps a Last.fm scrobble to an immutable listening event input", () => {
  const event = mapRecentTrackToListeningEvent({
    name: "Learning to Live",
    artist: { name: "Dream Theater", mbid: "artist-mbid" },
    album: { "#text": "Images and Words", mbid: "album-mbid" },
    mbid: "track-mbid",
    url: "https://www.last.fm/music/Dream+Theater/_/Learning+to+Live",
    loved: "1",
    date: { uts: "1213031819", "#text": "9 Jun 2008, 17:16" },
  });

  assert.ok(event);
  assert.equal(event.source, "LASTFM_SCROBBLE");
  assert.equal(event.trackName, "Learning to Live");
  assert.equal(event.artistName, "Dream Theater");
  assert.equal(event.albumName, "Images and Words");
  assert.equal(event.trackMbid, "track-mbid");
  assert.equal(event.artistMbid, "artist-mbid");
  assert.equal(event.albumMbid, "album-mbid");
  assert.equal(event.loved, true);
  assert.equal(event.playedAt.toISOString(), "2008-06-09T17:16:59.000Z");
  assert.match(event.sourceEventKey, /^lastfm:[a-f0-9]{64}$/);
});

test("source event key is stable across cosmetic case/Unicode normalization", () => {
  const playedAt = new Date("2026-08-12T18:00:00.000Z");
  const first = lastFmSourceEventKey({
    playedAt,
    trackName: "Café",
    artistName: "Artist",
    albumName: "Album",
  });
  const second = lastFmSourceEventKey({
    playedAt,
    trackName: "CAFÉ",
    artistName: "artist",
    albumName: "album",
  });
  assert.equal(first, second);
});

test("recent tracks skips now-playing rows without a completed timestamp", async () => {
  let requestedUrl = "";
  const client = new LastFmClient({
    apiKey: "test-key",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        recenttracks: {
          track: [
            {
              name: "Current",
              artist: { name: "Artist" },
              "@attr": { nowplaying: "true" },
            },
            {
              name: "Completed",
              artist: { name: "Artist" },
              album: { "#text": "Album" },
              date: { uts: "1770000000" },
            },
          ],
          "@attr": {
            user: "marks",
            page: "2",
            perPage: "200",
            totalPages: "15",
            total: "2890",
          },
        },
      });
    },
  });

  const page = await client.getRecentTracksPage({
    username: "marks",
    page: 2,
    limit: 200,
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-08-12T00:00:00.000Z"),
  });

  assert.equal(page.events.length, 1);
  assert.equal(page.nowPlayingCount, 1);
  assert.equal(page.invalidCount, 0);
  assert.equal(page.page, 2);
  assert.equal(page.totalPages, 15);
  assert.equal(page.total, 2890);

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("method"), "user.getrecenttracks");
  assert.equal(url.searchParams.get("api_key"), "test-key");
  assert.equal(url.searchParams.get("limit"), "200");
  assert.equal(url.searchParams.get("extended"), "1");
  assert.equal(url.searchParams.get("format"), "json");
  assert.ok(url.searchParams.get("from"));
  assert.ok(url.searchParams.get("to"));
});

test("recent tracks rejects provider page size above the documented maximum", async () => {
  const client = new LastFmClient({
    apiKey: "test-key",
    fetchImpl: async () => jsonResponse({}),
  });

  await assert.rejects(
    client.getRecentTracksPage({
      username: "marks",
      limit: LASTFM_RECENT_TRACKS_MAX_LIMIT + 1,
    }),
    /cannot exceed 200/,
  );
});

test("getUserInfo parses account playcount for backfill diagnostics", async () => {
  const client = new LastFmClient({
    apiKey: "test-key",
    fetchImpl: async () =>
      jsonResponse({
        user: {
          name: "marks",
          realname: "Marcos",
          url: "https://www.last.fm/user/marks",
          playcount: "123456",
          registered: { unixtime: "1325376000" },
        },
      }),
  });

  const profile = await client.getUserInfo("marks");
  assert.equal(profile.username, "marks");
  assert.equal(profile.playCount, 123456);
  assert.equal(profile.registeredAt?.toISOString(), "2012-01-01T00:00:00.000Z");
});

test("getTopTracksPage preserves Last.fm personal playcounts for reconciliation", async () => {
  const client = new LastFmClient({
    apiKey: "test-key",
    fetchImpl: async () =>
      jsonResponse({
        toptracks: {
          track: [
            {
              name: "Track A",
              playcount: "42",
              mbid: "track-a-mbid",
              artist: { name: "Artist A", mbid: "artist-a-mbid" },
            },
          ],
          "@attr": { user: "marks", page: "1", totalPages: "3", total: "401" },
        },
      }),
  });

  const result = await client.getTopTracksPage({ username: "marks" });
  assert.deepEqual(result.tracks, [
    {
      trackName: "Track A",
      artistName: "Artist A",
      playCount: 42,
      trackMbid: "track-a-mbid",
      artistMbid: "artist-a-mbid",
    },
  ]);
  assert.equal(result.total, 401);
});

test("read client surfaces Last.fm API errors without attempting authentication", async () => {
  const client = new LastFmClient({
    apiKey: "bad-key",
    fetchImpl: async () => jsonResponse({ error: 10, message: "Invalid API key" }, 403),
  });

  await assert.rejects(client.getUserInfo("marks"), /Last\.fm API error 10/);
});
