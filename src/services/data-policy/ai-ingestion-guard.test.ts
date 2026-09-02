import assert from "node:assert/strict";
import test from "node:test";

import {
  DATA_ORIGINS,
  lineageFromOrigins,
  lineageFromRootSource,
  mergeLineages,
} from "./provenance";
import {
  AI_INGESTION_POLICY_USE,
  AiIngestionPolicyError,
  authorizeAiIngestion,
  evaluateAiIngestion,
  runAiIngestion,
} from "./ai-ingestion-guard";

test("Gate 3 is scoped to AI ingestion", () => {
  assert.equal(AI_INGESTION_POLICY_USE, "AI");
});

test("empty lineage normalizes to UNKNOWN and fails closed", () => {
  const evaluation = evaluateAiIngestion(lineageFromOrigins([]));

  assert.deepEqual(evaluation.lineage, { origins: ["UNKNOWN"] });
  assert.equal(evaluation.decision, "DENY");
});

test("Spotify lineage is denied for AI ingestion", () => {
  const lineage = lineageFromRootSource("SPOTIFY_RECENTLY_PLAYED");

  assert.throws(
    () => authorizeAiIngestion(lineage),
    (error: unknown) => {
      assert.ok(error instanceof AiIngestionPolicyError);
      assert.equal(error.code, "DATA_POLICY_AI_INGESTION_BLOCKED");
      assert.equal(error.decision, "DENY");
      assert.deepEqual(error.lineage.origins, ["SPOTIFY"]);
      return true;
    },
  );
});

test("first-party AI REVIEW_REQUIRED is still blocked", () => {
  const lineage = lineageFromRootSource("SONORIZA_INTERACTION");

  assert.throws(
    () => authorizeAiIngestion(lineage),
    (error: unknown) => {
      assert.ok(error instanceof AiIngestionPolicyError);
      assert.equal(error.decision, "REVIEW_REQUIRED");
      return true;
    },
  );
});

test("mixed first-party plus Spotify lineage cannot be laundered into AI", () => {
  const mixed = mergeLineages(
    lineageFromRootSource("USER_EXPLICIT"),
    lineageFromRootSource("SPOTIFY_RECENTLY_PLAYED"),
  );

  const evaluation = evaluateAiIngestion(mixed);

  assert.deepEqual(evaluation.lineage.origins, ["FIRST_PARTY", "SPOTIFY"]);
  assert.equal(evaluation.decision, "DENY");
});

test("blocked AI ingestion never invokes the side-effect operation", () => {
  let invoked = false;
  const lineage = lineageFromRootSource("SPOTIFY_EXTENDED_HISTORY");

  assert.throws(() =>
    runAiIngestion(lineage, () => {
      invoked = true;
      return "should-not-run";
    }),
  );

  assert.equal(invoked, false);
});

test("all current origins are fail-closed for AI until explicitly approved", () => {
  for (const origin of DATA_ORIGINS) {
    const evaluation = evaluateAiIngestion(lineageFromOrigins([origin]));
    assert.notEqual(
      evaluation.decision,
      "ALLOW",
      `origin=${origin} unexpectedly became AI ALLOW`,
    );
  }
});
