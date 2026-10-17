import assert from "node:assert/strict";
import test from "node:test";
import { spotifyRequestAttempt } from "@/services/spotify/request";

import {
  requiresAudiobookPlaylistReconciliation,
  withAudiobookWriteAdmission,
  type AudiobookWriteFenceKey,
} from "./write-admission";

const path = "/playlists/4kYizEAtQhFsrrwD3tFphP/items";
const input = { userId: "owner", method: "PUT", path };
const expectedKey: AudiobookWriteFenceKey = {
  userId: "owner",
  spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
};

test("#489 B.2: admission commits before transport and releases on success", async () => {
  const order: string[] = [];
  const result = await withAudiobookWriteAdmission(
    input,
    {
      begin: async key => {
        assert.deepEqual(key, expectedKey);
        order.push("begin");
      },
      finish: async (key, reviewRequired) => {
        assert.deepEqual(key, expectedKey);
        assert.equal(reviewRequired, false);
        order.push("finish");
      },
    },
    async () => { order.push("spotify"); return { status: 201 }; },
  );
  assert.deepEqual(result, { status: 201 });
  assert.deepEqual(order, ["begin", "spotify", "finish"]);
});

test("#489 B.2: failed admission prevents the provider mutation", async () => {
  let executed = false;
  await assert.rejects(
    withAudiobookWriteAdmission(input, {
      begin: async () => { throw new Error("blocked"); },
      finish: async () => { throw new Error("should not release"); },
    }, async () => { executed = true; }),
    /blocked/,
  );
  assert.equal(executed, false);
});

test("#489 B.2: unknown outcome durably marks review required", async () => {
  let observed: boolean | undefined;
  const error = Object.assign(new Error("Spotify timeout"), { status: 0 });
  await assert.rejects(
    withAudiobookWriteAdmission(
      input,
      {
        begin: async () => {},
        finish: async (_key, reviewRequired) => { observed = reviewRequired; },
      },
      async () => { throw error; },
    ),
    /Spotify timeout/,
  );
  assert.equal(observed, true);
});

test("#489 B.2: provider 502 and network exceptions require reconciliation", () => {
  for (const error of [
    new Error("network failed"),
    Object.assign(new Error("gateway"), { status: 502 }),
    Object.assign(new Error("timeout"), { status: 408 }),
    Object.assign(new Error("too early"), { status: 425 }),
    Object.assign(new Error("timeout kind"), { kind: "WRITE_TIMEOUT", status: 0 }),
  ]) {
    assert.equal(requiresAudiobookPlaylistReconciliation(error), true);
  }
});

test("#489 B.2: explicit provider rejection does not claim uncertain mutation", () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    assert.equal(requiresAudiobookPlaylistReconciliation({ status }), false);
  }
});

test("#489 B.2: GET and unrelated playlist creations are unaffected", async () => {
  for (const request of [
    { ...input, method: "GET" },
    { ...input, path: "/me/playlists", method: "POST" },
  ]) {
    const calls: string[] = [];
    await withAudiobookWriteAdmission(
      request,
      {
        begin: async () => { calls.push("begin"); },
        finish: async () => { calls.push("finish"); },
      },
      async () => { calls.push("spotify"); },
    );
    assert.deepEqual(calls, ["spotify"]);
  }
});

test("#489 B.2: a failed fence release must never report successful delivery", async () => {
  await assert.rejects(
    withAudiobookWriteAdmission(input, {
      begin: async () => {},
      finish: async () => { throw new Error("FENCE_RELEASE_FAILED"); },
    }, async () => "provider-ok"),
    /FENCE_RELEASE_FAILED/,
  );
});

test("#489 B.2: transport forbids direct writes without durable admission when enabled", { concurrency: false }, async () => {
  const before = process.env.AUDIOBOOK02_WRITE_FENCE_MODE;
  const fetchBefore = globalThis.fetch;
  let called = false;
  process.env.AUDIOBOOK02_WRITE_FENCE_MODE = "ACTIVE";
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("unexpected network request");
  }) as typeof fetch;
  try {
    await assert.rejects(
      spotifyRequestAttempt({
        accessToken: "dummy-test-token",
        path,
        method: "PUT",
        operation: "playlist-write",
        init: { method: "PUT", body: JSON.stringify({ uris: [] }) },
      }),
      /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_DIRECT_TRANSPORT/,
    );
    assert.equal(called, false, "no external Spotify request may be sent");
  } finally {
    globalThis.fetch = fetchBefore;
    if (before === undefined) delete process.env.AUDIOBOOK02_WRITE_FENCE_MODE;
    else process.env.AUDIOBOOK02_WRITE_FENCE_MODE = before;
  }
});

test("#489 B.2: missing user is blocked before acquiring or sending", async () => {
  let called = false;
  await assert.rejects(
    withAudiobookWriteAdmission({ ...input, userId: null }, {
      begin: async () => { called = true; },
      finish: async () => { called = true; },
    }, async () => { called = true; }),
    /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_UNKNOWN_USER/,
  );
  assert.equal(called, false);
});
