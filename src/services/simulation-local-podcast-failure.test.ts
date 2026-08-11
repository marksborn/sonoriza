import assert from "node:assert/strict";
import test from "node:test";

import { readInconclusiveSimulation } from "./simulation-presentation";

test("identifies a local post-response podcast failure when calls equal pages received", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    inconclusiveReason: "SOURCE_UNAVAILABLE",
    spotifyApi: {
      totalCalls: 2,
      callsByOperation: {
        "show-episodes": 1,
        "playlist-metadata": 1,
      },
    },
    sourceCollection: {
      configuredSourceCount: 3,
      readSourceCount: 1,
      confirmedSourceCount: 1,
      unavailableSourceCount: 1,
      notAttemptedSourceCount: 1,
      failures: [
        {
          source: "Realidades Paralelas do Guaxinim - RPGuaxa",
          kind: "PODCAST",
          spotifyType: "SHOW",
          errorKind: "SOURCE_READ_FAILED",
          status: null,
          reason: null,
          operation: null,
          retryAfterSeconds: null,
        },
      ],
      sources: [
        {
          source: "Escutar",
          kind: "MUSIC",
          spotifyType: "PLAYLIST",
          state: "CONFIRMED",
          pagesRead: 0,
          partialRead: false,
          errorKind: null,
          status: null,
          reason: null,
          operation: null,
          retryAfterSeconds: null,
        },
        {
          source: "Realidades Paralelas do Guaxinim - RPGuaxa",
          kind: "PODCAST",
          spotifyType: "SHOW",
          state: "UNAVAILABLE",
          pagesRead: 1,
          partialRead: true,
          errorKind: "SOURCE_READ_FAILED",
          status: null,
          reason: null,
          operation: null,
          retryAfterSeconds: null,
        },
        {
          source: "Seus episódios",
          kind: "PODCAST",
          spotifyType: "SAVED_EPISODES",
          state: "NOT_ATTEMPTED",
          pagesRead: 0,
          partialRead: false,
          errorKind: null,
          status: null,
          reason: null,
          operation: null,
          retryAfterSeconds: null,
        },
      ],
    },
  });

  assert.ok(view);
  const diagnostic = view.sourceDiagnostics.find(
    (entry) => entry.source === "Realidades Paralelas do Guaxinim - RPGuaxa",
  );
  assert.ok(diagnostic);
  assert.match(diagnostic.detail, /Spotify entregou a página solicitada/i);
  assert.match(diagnostic.detail, /processamento local dos episódios/i);
  assert.doesNotMatch(diagnostic.detail, /quota|HTTP|rate limit/i);
  assert.match(view.message, /leitura e o processamento/i);
});

test("does not misclassify a failed second provider request as local processing", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    spotifyApi: {
      callsByOperation: { "show-episodes": 2 },
    },
    sourceCollection: {
      sources: [
        {
          source: "Programa",
          kind: "PODCAST",
          spotifyType: "SHOW",
          state: "UNAVAILABLE",
          pagesRead: 1,
          partialRead: true,
          errorKind: "SOURCE_READ_FAILED",
          status: null,
          operation: null,
        },
      ],
    },
  });

  assert.ok(view);
  assert.doesNotMatch(
    view.sourceDiagnostics[0]?.detail ?? "",
    /processamento local dos episódios/i,
  );
});

test("exact OBSERVE_STATE diagnostic is rendered from the persisted source summary", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    inconclusiveReason: "SOURCE_UNAVAILABLE",
    sourceCollection: {
      configuredSourceCount: 3,
      readSourceCount: 1,
      confirmedSourceCount: 1,
      unavailableSourceCount: 1,
      notAttemptedSourceCount: 1,
      failures: [
        {
          source: "Realidades Paralelas do Guaxinim - RPGuaxa",
          kind: "PODCAST",
          spotifyType: "SHOW",
          errorKind: "LOCAL_PROCESSING_ERROR",
          status: 0,
          reason: "LOCAL|OBSERVE_STATE|PrismaClientKnownRequestError|P2028",
          operation: "observe-state",
          retryAfterSeconds: null,
        },
      ],
      sources: [
        {
          source: "Realidades Paralelas do Guaxinim - RPGuaxa",
          kind: "PODCAST",
          spotifyType: "SHOW",
          state: "UNAVAILABLE",
          pagesRead: 1,
          partialRead: true,
          errorKind: "LOCAL_PROCESSING_ERROR",
          status: 0,
          reason: "LOCAL|OBSERVE_STATE|PrismaClientKnownRequestError|P2028",
          operation: "observe-state",
          retryAfterSeconds: null,
        },
      ],
    },
  });

  assert.ok(view);
  const diagnostic = view.sourceDiagnostics[0];
  assert.match(diagnostic?.detail ?? "", /persistência e consolidação do estado de escuta/i);
  assert.match(diagnostic?.detail ?? "", /OBSERVE_STATE/i);
  assert.match(diagnostic?.detail ?? "", /PrismaClientKnownRequestError/i);
  assert.match(diagnostic?.detail ?? "", /P2028/i);
  assert.equal(diagnostic?.httpStatus, null);
  assert.equal(diagnostic?.operation, "observe-state");
});

test("local diagnostic parser does not expose arbitrary reason payloads", () => {
  const view = readInconclusiveSimulation({
    inconclusive: true,
    sourceCollection: {
      sources: [
        {
          source: "Programa",
          kind: "PODCAST",
          spotifyType: "SHOW",
          state: "UNAVAILABLE",
          pagesRead: 1,
          partialRead: true,
          errorKind: "LOCAL_PROCESSING_ERROR",
          status: 0,
          reason: "LOCAL|OBSERVE_STATE|Error|password=secret",
          operation: "observe-state",
        },
      ],
    },
  });

  assert.ok(view);
  assert.doesNotMatch(JSON.stringify(view), /password=secret/i);
  assert.doesNotMatch(view.sourceDiagnostics[0]?.detail ?? "", /password=secret/i);
});