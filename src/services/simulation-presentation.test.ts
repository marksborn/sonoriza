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
          status: 429,
          operation: "playlist-items",
        },
        {
          source: "PLAYLIST:another-internal-id",
          kind: "PODCAST",
          spotifyType: "PLAYLIST",
          spotifyId: "another-internal-id",
          errorKind: "QUOTA_EXCEEDED",
          status: 429,
          operation: "playlist-items",
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
  assert.equal(view.notAttemptedSourceCount, 0);
  assert.equal(view.countsExact, false);
  assert.deepEqual(view.unavailableSources, [
    "Músicas principais",
    "Playlist de podcasts do Spotify",
  ]);
  assert.equal(view.sourceDiagnostics.length, 2);
  assert.match(view.sourceDiagnostics[0]?.detail ?? "", /quota disponível foi atingida/i);
  assert.match(view.sourceDiagnostics[0]?.detail ?? "", /itens da playlist/i);
  assert.equal(view.sourceDiagnostics[0]?.httpStatus, 429);
  assert.equal(view.canRetryFromCard, false);
  assert.doesNotMatch(view.message, /ajust|incorret|meta não atendida/i);
  assert.doesNotMatch(JSON.stringify(view), /secret-looking-id|another-internal-id/);
});

test("legacy 3/1/1 summary exposes the missing source as not attempted", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    inconclusiveReason: "SOURCE_UNAVAILABLE",
    sourceCollection: {
      configuredSourceCount: 3,
      readSourceCount: 1,
      unavailableSourceCount: 1,
      failures: [
        {
          source: "Realidades Paralelas do Guaxinim",
          kind: "PODCAST",
          spotifyType: "SHOW",
          errorKind: "HTTP_ERROR",
          status: 503,
          operation: "show-episodes",
        },
      ],
    },
  });

  assert.ok(view);
  assert.equal(view.notAttemptedSourceCount, 1);
  assert.equal(view.countsExact, false);
  assert.equal(view.sourceDiagnostics[0]?.source, "Realidades Paralelas do Guaxinim");
  assert.match(view.sourceDiagnostics[0]?.detail ?? "", /falha temporária/i);
  assert.match(view.sourceDiagnostics[0]?.detail ?? "", /episódios do programa/i);
  assert.match(view.sourceDiagnostics[0]?.detail ?? "", /HTTP 503/i);
});

test("explicit not-attempted count is preferred when the collector records an exact value", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    sourceCollection: {
      configuredSourceCount: 3,
      readSourceCount: 2,
      unavailableSourceCount: 1,
      notAttemptedSourceCount: 1,
      failures: [
        {
          source: "Fonte parcialmente lida",
          kind: "PODCAST",
          spotifyType: "PLAYLIST",
          errorKind: "SOURCE_READ_FAILED",
        },
      ],
    },
  });

  assert.ok(view);
  // A fonte indisponível pode já ter sido lida parcialmente. O valor exato do
  // coletor prevalece sobre a aritmética legada 3 - 2 - 1 = 0.
  assert.equal(view.notAttemptedSourceCount, 1);
  assert.equal(view.countsExact, true);
});

test("rate limited preserves a safe Retry-After hint and per-source explanation", () => {
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
          status: 429,
          operation: "show-episodes",
          retryAfterSeconds: 12,
        },
      ],
    },
  });

  assert.ok(view);
  assert.equal(view.reason, "RATE_LIMITED");
  assert.match(view.retryHint, /12 segundos/);
  assert.match(view.sourceDiagnostics[0]?.detail ?? "", /12 segundos/);
  assert.match(view.sourceDiagnostics[0]?.detail ?? "", /episódios do programa/i);
  assert.equal(view.canRetryFromCard, false);
});

test("HTTP source errors are translated without exposing provider payloads", () => {
  const notFound = readInconclusiveSimulation({
    inconclusive: true,
    sourceCollection: {
      failures: [
        {
          source: "Programa X",
          kind: "PODCAST",
          spotifyType: "SHOW",
          spotifyId: "do-not-show-this-id",
          errorKind: "HTTP_ERROR",
          status: 404,
          operation: "show-episodes",
          providerBody: "Authorization: Bearer do-not-show-this-token",
        },
      ],
    },
  });

  assert.ok(notFound);
  assert.match(notFound.sourceDiagnostics[0]?.detail ?? "", /não foi encontrada/i);
  assert.match(notFound.sourceDiagnostics[0]?.detail ?? "", /HTTP 404/i);
  assert.doesNotMatch(
    JSON.stringify(notFound),
    /do-not-show-this-id|do-not-show-this-token|Authorization|Bearer/i,
  );
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
