import assert from "node:assert/strict";
import test from "node:test";

import {
  runSummaryMentionsTarget,
  summarizeGenerationRunDiagnostic,
} from "./generation-run-diagnostics";

test("summarizes a partial 502 source read without exposing raw provider payload", () => {
  const diagnostic = summarizeGenerationRunDiagnostic({
    error: "raw error should not be needed",
    summary: {
      sourceCollection: {
        failures: [
          {
            source: "Welcome to Night Vale",
            status: 502,
            errorKind: "HTTP_ERROR",
            operation: "show-episodes",
            retryAfterSeconds: null,
          },
        ],
        sources: [
          {
            source: "Welcome to Night Vale",
            pagesRead: 2,
            partialRead: true,
          },
        ],
      },
    },
  });

  assert.ok(diagnostic);
  assert.equal(diagnostic.headline, "Fonte temporariamente indisponível");
  assert.equal(diagnostic.source, "Welcome to Night Vale");
  assert.equal(diagnostic.providerStatus, 502);
  assert.equal(diagnostic.operation, "show-episodes");
  assert.equal(diagnostic.pagesRead, 2);
  assert.equal(diagnostic.partialRead, true);
});

test("target membership is recovered from targetScope or target summaries", () => {
  assert.equal(runSummaryMentionsTarget({ targetScope: ["target-a"] }, "target-a"), true);
  assert.equal(
    runSummaryMentionsTarget({ targets: [{ targetPlaylistId: "target-b" }] }, "target-b"),
    true,
  );
  assert.equal(runSummaryMentionsTarget({ targetScope: ["target-a"] }, "target-z"), false);
});

test("free-text diagnostics reject strings that look sensitive", () => {
  assert.equal(
    summarizeGenerationRunDiagnostic({
      summary: null,
      error: "Authorization: Bearer abc123",
    }),
    null,
  );
});
