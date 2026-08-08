import assert from "node:assert/strict";
import test from "node:test";

import { readInconclusiveSimulation } from "./simulation-presentation";

test("quota exceeded is presented as inconclusive without suggesting configuration changes", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    inconclusiveReason: "QUOTA_EXCEEDED",
    sourceCollection: {
      configuredSourceCount: 3,
      readSourceCount: 1,
      unavailableSourceCount: 2,
      failures: [
        {
          source: "Músicas principais",
          kind: "MUSIC",
          spotifyType: "PLAYLIST",
          spotifyId: "secret-looking-id",
          errorKind: "QUOTA_EXCEEDED",
        },
        {
          source: "PLAYLIST:another-internal-id",
          kind: "PODCAST",
          spotifyType: "PLAYLIST",
          spotifyId: "another-internal-id",
          errorKind: "QUOTA_EXCEEDED",
        },
      ],
    },
  });

  assert.ok(view);
  assert.equal(view.title, "Não foi possível concluir a simulação");
  assert.equal(view.reason, "QUOTA_EXCEEDED");
  assert.equal(view.configuredSourceCount, 3);
  assert.equal(view.readSourceCount, 1);
  assert.equal(view.unavailableSourceCount, 2);
  assert.deepEqual(view.unavailableSources, [
    "Músicas principais",
    "Playlist de podcasts do Spotify",
  ]);
  assert.equal(view.canRetryFromCard, false);
  assert.doesNotMatch(view.message, /ajust|incorret|meta não atendida/i);
  assert.doesNotMatch(JSON.stringify(view), /secret-looking-id|another-internal-id/);
});

test("rate limited preserves a safe Retry-After hint", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    inconclusiveReason: "RATE_LIMITED",
    sourceCollection: {
      configuredSourceCount: 2,
      readSourceCount: 1,
      unavailableSourceCount: 1,
      failures: [
        {
          source: "Podcasts",
          kind: "PODCAST",
          spotifyType: "SHOW",
          errorKind: "RATE_LIMITED",
          retryAfterSeconds: 12,
        },
      ],
    },
  });

  assert.ok(view);
  assert.equal(view.reason, "RATE_LIMITED");
  assert.match(view.retryHint, /12 segundos/);
  assert.equal(view.canRetryFromCard, false);
});

test("generic source unavailability allows a deliberate retry from the result card", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    sourceCollection: {
      failures: [
        {
          source: "SHOW:internal-show-id",
          kind: "PODCAST",
          spotifyType: "SHOW",
          errorKind: "SOURCE_READ_FAILED",
        },
      ],
    },
  });

  assert.ok(view);
  assert.equal(view.reason, "SOURCE_UNAVAILABLE");
  assert.deepEqual(view.unavailableSources, ["Programa do Spotify"]);
  assert.equal(view.canRetryFromCard, true);
});

test("normal simulation summary does not create an inconclusive view", () => {
  assert.equal(
    readInconclusiveSimulation({ inconclusive: false, qualityPassed: true }),
    null,
  );
  assert.equal(readInconclusiveSimulation(null), null);
});
