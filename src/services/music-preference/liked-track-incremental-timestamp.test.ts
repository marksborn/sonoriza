import assert from "node:assert/strict";
import test from "node:test";

import { readSpotifyLikedTrackIncremental } from "./liked-track-incremental-sync";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("Gate 4B treats Z and .000Z as the same Saved Tracks boundary instant", async () => {
  const result = await readSpotifyLikedTrackIncremental(
    "token",
    {
      watermarkAddedAt: "2026-08-25T11:17:30.000Z",
      boundaryTrackIds: ["boundary-track"],
    },
    (async () =>
      response({
        items: [
          {
            added_at: "2026-08-25T11:17:30Z",
            track: {
              id: "boundary-track",
              uri: "spotify:track:boundary-track",
              name: "Boundary",
              duration_ms: 180_000,
              type: "track",
              is_playable: true,
              artists: [{ id: "artist", name: "Artist" }],
              album: { id: "album", name: "Album" },
            },
          },
          {
            added_at: "2026-08-24T11:17:30Z",
            track: {
              id: "older-track",
              uri: "spotify:track:older-track",
              name: "Older",
              duration_ms: 180_000,
              type: "track",
              is_playable: true,
              artists: [{ id: "artist", name: "Artist" }],
              album: { id: "album", name: "Album" },
            },
          },
        ],
        next: null,
      })) as typeof fetch,
  );

  assert.equal(result.pagesRead, 1);
  assert.equal(result.stoppedAtOlderItem, true);
  assert.deepEqual(result.newItems, []);
  assert.equal(result.items[0]?.addedAt, "2026-08-25T11:17:30.000Z");
});
