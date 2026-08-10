import assert from "node:assert/strict";
import test from "node:test";

import { buildSourceCollectionDiagnosticSummary } from "./source-collection-diagnostics";

const sources = [
  {
    id: "source-1",
    name: "Escutar",
    kind: "MUSIC",
    spotifyType: "PLAYLIST",
    spotifyId: "private-playlist-1",
  },
  {
    id: "source-2",
    name: "Realidades Paralelas do Guaxinim",
    kind: "PODCAST",
    spotifyType: "SHOW",
    spotifyId: "private-show-2",
  },
  {
    id: "source-3",
    name: null,
    kind: "PODCAST",
    spotifyType: "SAVED_EPISODES",
    spotifyId: "saved",
  },
];

test("classifies one confirmed, one unavailable and one not attempted", () => {
  const summary = buildSourceCollectionDiagnosticSummary({
    sources,
    attemptedSourceIds: new Set(["source-1", "source-2"]),
    readSourceIds: new Set(["source-1"]),
    failures: [
      {
        sourceId: "source-2",
        source: "Realidades Paralelas do Guaxinim",
        kind: "PODCAST",
        spotifyType: "SHOW",
        errorKind: "QUOTA_EXCEEDED",
        status: 429,
        reason: "QUOTA_EXCEEDED",
        operation: "show-episodes",
        retryAfterSeconds: null,
      },
    ],
  });

  assert.equal(summary.configuredSourceCount, 3);
  assert.equal(summary.attemptedSourceCount, 2);
  assert.equal(summary.readSourceCount, 1);
  assert.equal(summary.confirmedSourceCount, 1);
  assert.equal(summary.unavailableSourceCount, 1);
  assert.equal(summary.notAttemptedSourceCount, 1);
  assert.deepEqual(
    summary.sources.map((source) => [source.source, source.state]),
    [
      ["Escutar", "CONFIRMED"],
      ["Realidades Paralelas do Guaxinim", "UNAVAILABLE"],
      ["Seus episódios", "NOT_ATTEMPTED"],
    ],
  );
});

test("a source read successfully before a later failure ends as unavailable, not confirmed", () => {
  const summary = buildSourceCollectionDiagnosticSummary({
    sources: [sources[1]!],
    attemptedSourceIds: new Set(["source-2"]),
    readSourceIds: new Set(["source-2"]),
    failures: [
      {
        sourceId: "source-2",
        source: "Realidades Paralelas do Guaxinim",
        kind: "PODCAST",
        spotifyType: "SHOW",
        errorKind: "HTTP_ERROR",
        status: 503,
        reason: null,
        operation: "show-episodes",
        retryAfterSeconds: null,
      },
    ],
    sourceReads: {
      "SHOW:private-show-2": { pagesRead: 2 },
    },
  });

  assert.equal(summary.confirmedSourceCount, 0);
  assert.equal(summary.unavailableSourceCount, 1);
  assert.equal(summary.notAttemptedSourceCount, 0);
  assert.equal(summary.sources[0]?.state, "UNAVAILABLE");
  assert.equal(summary.sources[0]?.partialRead, true);
  assert.equal(summary.sources[0]?.pagesRead, 2);
});

test("setup failure leaves successfully prepared but unread sources as not attempted", () => {
  const summary = buildSourceCollectionDiagnosticSummary({
    sources,
    attemptedSourceIds: new Set(["source-1"]),
    readSourceIds: new Set(),
    failures: [
      {
        sourceId: "source-1",
        source: "Escutar",
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        errorKind: "HTTP_ERROR",
        status: 404,
        reason: null,
        operation: "playlist-metadata",
        retryAfterSeconds: null,
      },
    ],
  });

  assert.equal(summary.confirmedSourceCount, 0);
  assert.equal(summary.unavailableSourceCount, 1);
  assert.equal(summary.notAttemptedSourceCount, 2);
});

test("serialized diagnostics never expose source ids", () => {
  const summary = buildSourceCollectionDiagnosticSummary({
    sources,
    attemptedSourceIds: new Set(["source-2"]),
    readSourceIds: new Set(),
    failures: [
      {
        sourceId: "source-2",
        source: "Realidades Paralelas do Guaxinim",
        kind: "PODCAST",
        spotifyType: "SHOW",
        errorKind: "RATE_LIMITED",
        status: 429,
        reason: null,
        operation: "show-episodes",
        retryAfterSeconds: 30,
      },
    ],
  });

  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /source-2|private-show-2|private-playlist-1/);
});
