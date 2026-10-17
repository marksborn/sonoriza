import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertAudiobookPlaylistMutationAllowed,
  parseSpotifyPlaylistItemsMutation,
} from "./playlist-write-guard";

const TARGET = "/playlists/4kYizEAtQhFsrrwD3tFphP/items";

test("#489 Gate B: all playlist item writes map to the same protected Spotify identity", () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "post"]) {
    assert.deepEqual(parseSpotifyPlaylistItemsMutation(TARGET, method), {
      spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
      method: method.toUpperCase(),
    });
  }
  assert.deepEqual(
    parseSpotifyPlaylistItemsMutation(TARGET + "?limit=20", "PUT"),
    { spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP", method: "PUT" },
  );
});

test("#489 Gate B: provider reads and unrelated writes remain untouched", async () => {
  for (const request of [
    { userId: null, method: "GET", path: TARGET },
    { userId: "user", method: "POST", path: "/me/playlists" },
    { userId: "user", method: "PUT", path: "/playlists/abc" },
    { userId: "user", method: "GET", path: "/playlists/abc/items?limit=50" },
  ]) {
    let checks = 0;
    await assertAudiobookPlaylistMutationAllowed(request, async () => {
      checks += 1;
      return true;
    });
    assert.equal(checks, 0);
  }
});

test("#489 Gate B: an explicitly protected playlist blocks all mutation methods", async () => {
  for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
    let calls = 0;
    await assert.rejects(
      () => assertAudiobookPlaylistMutationAllowed(
        { userId: "owner", path: TARGET, method },
        async (userId, playlistId) => {
          assert.equal(userId, "owner");
          assert.equal(playlistId, "4kYizEAtQhFsrrwD3tFphP");
          calls += 1;
          return true;
        },
      ),
      /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_PROTECTED_TARGET/,
    );
    assert.equal(calls, 1);
  }
});

test("#489 Gate B: unprotected targets keep the existing write path", async () => {
  await assert.doesNotReject(() => assertAudiobookPlaylistMutationAllowed(
    { userId: "owner", method: "PUT", path: TARGET },
    async () => false,
  ));
});

test("#489 Gate B: DB failures prevent writes rather than silently assuming safe", async () => {
  await assert.rejects(
    () => assertAudiobookPlaylistMutationAllowed(
      { userId: "owner", path: TARGET, method: "PUT" },
      async () => { throw new Error("DB_OFFLINE"); },
    ),
    /DB_OFFLINE/,
  );
});

test("#489 Gate B: a non-boolean lookup response fails closed", async () => {
  await assert.rejects(
    () => assertAudiobookPlaylistMutationAllowed(
      { userId: "owner", path: TARGET, method: "POST" },
      async () => undefined as unknown as boolean,
    ),
    /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_INDETERMINATE/,
  );
});

test("#489 Gate B: user identity is mandatory for playlist mutations", async () => {
  for (const userId of [null, "", " "]) {
    await assert.rejects(
      () => assertAudiobookPlaylistMutationAllowed(
        { userId, path: TARGET, method: "DELETE" },
        async () => { throw new Error("should not query"); },
      ),
      /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_UNKNOWN_USER/,
    );
  }
});

test("#489 Gate B: legacy synthetic playlist IDs with hyphens remain checkable", async () => {
  const fixtureId = "playlist-target-0-123456-abcdef";
  const path = `/playlists/${fixtureId}/items`;
  assert.deepEqual(parseSpotifyPlaylistItemsMutation(path, "PUT"), {
    spotifyPlaylistId: fixtureId,
    method: "PUT",
  });
  let observed = "";
  await assert.doesNotReject(() => assertAudiobookPlaylistMutationAllowed(
    { userId: "fixture-owner", path, method: "PUT" },
    async (_userId, playlistId) => {
      observed = playlistId;
      return false;
    },
  ));
  assert.equal(observed, fixtureId);
});

test("#489 Gate B: malformed playlist IDs never bypass guard", () => {
  assert.throws(
    () => parseSpotifyPlaylistItemsMutation("/playlists/%20/items", "PUT"),
    /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_INVALID_PLAYLIST_ID/,
  );
});

test("#489 Gate B: shared client request checks before each provider attempt", () => {
  const client = readFileSync("src/services/spotify/client.ts", "utf8");
  const request = client.indexOf("private async request<T>(");
  const guard = client.indexOf("await assertAudiobookPlaylistMutationAllowed(", request);
  const provider = client.indexOf("return await spotifyRequestAttempt<T>(", request);
  assert.ok(request >= 0 && guard > request && provider > guard);
  const loop = client.indexOf("while (true)", request);
  assert.ok(loop >= 0 && loop < guard, "Guard must be inside the retry loop");
  assert.match(client, /prisma\.targetAudiobookOverlay\.findUnique\(/);
});

test("#489 Gate B: persistent association must have unique user-scoped remote identity", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema, /model TargetAudiobookOverlay \{/);
  assert.match(schema, /@@unique\(\[userId, spotifyPlaylistId\]\)/);
  assert.match(schema, /targetPlaylistId\s+String\s+@unique/);
  assert.match(schema, /userId, targetPlaylistId\], references: \[userId, id\]/);
});
