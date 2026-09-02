import assert from "node:assert/strict";
import test from "node:test";

import {
  MUSIC_05_COMPLIANCE_QUARANTINE_REASON,
  analyzeAndRecordInferredSkips,
  evaluateMusic05CompliancePolicy,
  loadPendingInferredSkips,
} from "./compliant-inferred-skips";
import type { MusicPreferenceSignalStore } from "./signal-store";

function throwingStore(): MusicPreferenceSignalStore {
  return {
    recordInferredSkips: async () => {
      throw new Error("quarantined path must not persist inferred skips");
    },
    listPendingSkips: async () => {
      throw new Error("quarantined path must not read pending inferred skips");
    },
    consume: async () => {
      throw new Error("not used");
    },
  };
}

test("MUSIC-05 Spotify lineage is not authorized for productive use", () => {
  const policy = evaluateMusic05CompliancePolicy();

  assert.deepEqual(policy.lineage.origins, ["SPOTIFY"]);
  assert.equal(policy.behavioralAnalytics, "DENY");
  assert.equal(policy.userProfiling, "DENY");
  assert.equal(policy.recommendation, "DENY");
  assert.equal(policy.plannerEligibility, "REVIEW_REQUIRED");
  assert.equal(policy.productiveUseAllowed, false);
});

test("productive analysis returns quarantine evidence without touching the store", async () => {
  const result = await analyzeAndRecordInferredSkips(
    "user-1",
    ["target-a", "target-b"],
    { store: throwingStore() },
  );

  assert.deepEqual(
    result.targets.map((target) => ({
      id: target.targetPlaylistId,
      reason: target.reason,
      created: target.createdSignalCount,
    })),
    [
      {
        id: "target-a",
        reason: MUSIC_05_COMPLIANCE_QUARANTINE_REASON,
        created: 0,
      },
      {
        id: "target-b",
        reason: MUSIC_05_COMPLIANCE_QUARANTINE_REASON,
        created: 0,
      },
    ],
  );
});

test("productive pending-skip loader returns empty target maps without reading legacy rows", async () => {
  const pending = await loadPendingInferredSkips(
    "user-1",
    ["target-a", "target-b"],
    { store: throwingStore(), includeCurrentInference: true },
  );

  assert.deepEqual(pending.get("target-a"), []);
  assert.deepEqual(pending.get("target-b"), []);
});
