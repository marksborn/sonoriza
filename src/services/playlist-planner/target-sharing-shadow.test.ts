import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_GLOBAL_SHARING_POLICY,
  resolveEffectiveSharingPolicy,
  sharingPoliciesConflict,
} from "./target-sharing-shadow";

test("#204 Gate 4 inheritance preserves legacy EXCLUSIVE", () => {
  assert.equal(
    resolveEffectiveSharingPolicy("INHERIT_GLOBAL"),
    "EXCLUSIVE",
  );
  assert.equal(LEGACY_GLOBAL_SHARING_POLICY, "EXCLUSIVE");
});

test("#204 Gate 4 explicit policy overrides inheritance", () => {
  assert.equal(resolveEffectiveSharingPolicy("EXCLUSIVE"), "EXCLUSIVE");
  assert.equal(resolveEffectiveSharingPolicy("SHAREABLE"), "SHAREABLE");
});

test("#204 Gate 4 symmetric sharing matrix allows only SHAREABLE + SHAREABLE", () => {
  assert.equal(sharingPoliciesConflict("EXCLUSIVE", "EXCLUSIVE"), true);
  assert.equal(sharingPoliciesConflict("EXCLUSIVE", "SHAREABLE"), true);
  assert.equal(sharingPoliciesConflict("SHAREABLE", "EXCLUSIVE"), true);
  assert.equal(sharingPoliciesConflict("SHAREABLE", "SHAREABLE"), false);
});

test("#204 Gate 4 pair semantics are order-independent", () => {
  const pairs = [
    ["EXCLUSIVE", "EXCLUSIVE"],
    ["EXCLUSIVE", "SHAREABLE"],
    ["SHAREABLE", "SHAREABLE"],
  ] as const;

  for (const [a, b] of pairs) {
    assert.equal(
      sharingPoliciesConflict(a, b),
      sharingPoliciesConflict(b, a),
    );
  }
});
