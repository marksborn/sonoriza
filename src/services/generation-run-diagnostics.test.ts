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

test("target membership is recovered from explicit scope, resolved scope or target summaries", () => {
  assert.equal(runSummaryMentionsTarget({ targetScope: ["target-a"] }, "target-a"), true);
  assert.equal(
    runSummaryMentionsTarget({ resolvedTargetIds: ["target-early"] }, "target-early"),
    true,
  );
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


test("#456 calendar-empty KEEP is an informational scheduled NOOP, not a failure", () => {
  const diagnostic = summarizeGenerationRunDiagnostic({
    runStatus: "SUCCESS",
    scheduleStatus: "NOOP",
    scheduleReason: "CALENDAR_EMPTY_KEEP",
    summary: { skipped: ["Carro"] },
    error: null,
  });

  assert.ok(diagnostic);
  assert.equal(diagnostic.tone, "info");
  assert.equal(diagnostic.headline, "Sem alterações — calendário vazio");
  assert.match(diagnostic.detail, /KEEP/);
  assert.doesNotMatch(diagnostic.headline, /não concluída/i);
});

test("#456 calendar-empty SKIP is informational; successful updated run has no diagnostic", () => {
  const skipped = summarizeGenerationRunDiagnostic({
    runStatus: "SUCCESS",
    scheduleStatus: "NOOP",
    scheduleReason: "CALENDAR_EMPTY_SKIP",
    summary: null,
    error: null,
  });
  assert.equal(skipped?.tone, "info");
  assert.match(skipped?.detail ?? "", /SKIP/);

  const updated = summarizeGenerationRunDiagnostic({
    runStatus: "SUCCESS",
    scheduleStatus: "SUCCESS",
    scheduleReason: null,
    summary: { targets: [{ applied: true }] },
    error: null,
  });
  assert.equal(updated, null);
});

test("#456 unknown successful NOOP reason is neutral and sensitive reasons remain hidden", () => {
  const diagnostic = summarizeGenerationRunDiagnostic({
    runStatus: "SUCCESS",
    scheduleStatus: "NOOP",
    scheduleReason: "Nothing changed",
    summary: null,
    error: null,
  });
  assert.equal(diagnostic?.tone, "info");
  assert.equal(diagnostic?.headline, "Sem alterações");

  const safe = summarizeGenerationRunDiagnostic({
    runStatus: "SUCCESS",
    scheduleStatus: "NOOP",
    scheduleReason: "Authorization: Bearer private-token",
    summary: null,
    error: null,
  });
  assert.equal(safe?.tone, "info");
  assert.doesNotMatch(safe?.detail ?? "", /Bearer|private-token/i);
});

test("#456 genuine FAILED, PARTIAL and BLOCKED remain warnings", () => {
  const failed = summarizeGenerationRunDiagnostic({
    runStatus: "FAILED",
    scheduleStatus: "FAILED",
    scheduleReason: "Provider unreachable",
    summary: null,
    error: null,
  });
  assert.equal(failed?.tone, "warning");
  assert.equal(failed?.headline, "Execução não concluída");

  const partial = summarizeGenerationRunDiagnostic({
    runStatus: "PARTIAL",
    scheduleStatus: "PARTIAL",
    scheduleReason: "Some tracks unavailable",
    summary: null,
    error: null,
  });
  assert.equal(partial?.tone, "warning");
  assert.equal(partial?.headline, "Execução parcial");

  const blocked = summarizeGenerationRunDiagnostic({
    runStatus: "FAILED",
    scheduleStatus: "BLOCKED",
    scheduleReason: "Provider backoff",
    summary: null,
    error: null,
  });
  assert.equal(blocked?.tone, "warning");
  assert.equal(blocked?.headline, "Execução bloqueada");
});

test("#456 success with unexpected harmless reason is an observation, not false failure", () => {
  const result = summarizeGenerationRunDiagnostic({
    runStatus: "SUCCESS",
    scheduleStatus: "SUCCESS",
    scheduleReason: "informational trace",
    summary: null,
    error: null,
  });
  assert.equal(result?.tone, "info");
  assert.equal(result?.headline, "Observação da execução");
});
