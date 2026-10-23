import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGate5CHistoricalPositions,
  validateGate5CHistoricalSelection,
} from "./musicbrainz-isrc-mbid-shadow-selection";

test("Gate 5D.3: legacy default keeps latest successful real generation", () => {
  assert.deepEqual(validateGate5CHistoricalSelection({}), {
    runId: null,
    positions: null,
  });
});

test("Gate 5D.3: historical positions 5,9,10 are bounded and explicit", () => {
  const positions = parseGate5CHistoricalPositions("5,9,10");
  assert.deepEqual(
    validateGate5CHistoricalSelection({
      runId: "cmvi01234567890", positions,
    }),
    { runId: "cmvi01234567890", positions: [5, 9, 10] },
  );
});

test("Gate 5D.3: positions cannot silently select the latest run", () => {
  assert.throws(
    () => validateGate5CHistoricalSelection({ positions: [5, 9, 10] }),
    /requires --run-id/,
  );
});

test("Gate 5D.3: exact positions and offset/limit must never mix", () => {
  assert.throws(
    () => validateGate5CHistoricalSelection({
      runId: "cmvi01234567890",
      positions: [5, 9, 10],
      paginationRequested: true,
    }),
    /cannot be combined/,
  );
});

test("Gate 5D.3: invalid positions fail before provider reads", () => {
  for (const raw of ["", "0", "-1", "5,", ",5", "5,5", "5,a", "5,9,10,11,12,13", "501", "1e2"]) {
    assert.throws(() => parseGate5CHistoricalPositions(raw));
  }
  assert.throws(
    () => validateGate5CHistoricalSelection({ runId: "bad run id", positions: [5] }),
    /invalid or empty historical run id/,
  );
  assert.throws(
    () => validateGate5CHistoricalSelection({ runId: "  ", positions: [5] }),
    /invalid or empty historical run id/,
  );
});

test("Gate 5D.3: position checks cannot be bypassed by a direct report caller", () => {
  for (const positions of [[5, 5], [0], [-2], [501], [2.5], [1, 2, 3, 4, 5, 6]]) {
    assert.throws(() => validateGate5CHistoricalSelection({
      runId: "cmvi01234567890", positions,
    }));
  }
});
