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
