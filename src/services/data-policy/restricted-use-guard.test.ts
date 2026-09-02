import assert from "node:assert/strict";
import test from "node:test";

import {
  DATA_ORIGINS,
  lineageFromOrigins,
  lineageFromRootSource,
  mergeLineages,
} from "./provenance";
import {
  RESTRICTED_POLICY_USES,
  RestrictedUsePolicyError,
  authorizeRestrictedUse,
  evaluateRestrictedUse,
  runRestrictedUse,
} from "./restricted-use-guard";

test("Gate 3 only exposes AI and external export as restricted uses", () => {
  assert.deepEqual(RESTRICTED_POLICY_USES, ["AI", "EXTERNAL_EXPORT"]);
});

test("empty lineage normalizes to UNKNOWN and fails closed", () => {
  const evaluation = evaluateRestrictedUse(lineageFromOrigins([]), "AI");

  assert.deepEqual(evaluation.lineage, { origins: ["UNKNOWN"] });
  assert.equal(evaluation.decision, "DENY");
});

test("Spotify lineage is denied for AI", () => {
  const lineage = lineageFromRootSource("SPOTIFY_RECENTLY_PLAYED");

  assert.throws(
    () => authorizeRestrictedUse(lineage, "AI"),
    (error: unknown) => {
      assert.ok(error instanceof RestrictedUsePolicyError);
      assert.equal(error.code, "DATA_POLICY_RESTRICTED_USE_BLOCKED");
      assert.equal(error.use, "AI");
      assert.equal(error.decision, "DENY");
      assert.deepEqual(error.lineage.origins, ["SPOTIFY"]);
      return true;
    },
  );
});

test("Spotify external export REVIEW_REQUIRED is still blocked", () => {
  const lineage = lineageFromRootSource("SPOTIFY_SAVED_TRACKS");

  assert.throws(
    () => authorizeRestrictedUse(lineage, "EXTERNAL_EXPORT"),
    (error: unknown) => {
      assert.ok(error instanceof RestrictedUsePolicyError);
      assert.equal(error.decision, "REVIEW_REQUIRED");
      return true;
    },
  );
});

test("first-party AI and export remain blocked until explicitly approved", () => {
  const lineage = lineageFromRootSource("SONORIZA_INTERACTION");

  for (const use of RESTRICTED_POLICY_USES) {
    assert.throws(
      () => authorizeRestrictedUse(lineage, use),
      (error: unknown) => {
        assert.ok(error instanceof RestrictedUsePolicyError);
        assert.equal(error.decision, "REVIEW_REQUIRED");
        return true;
      },
    );
  }
});

test("mixed first-party plus Spotify lineage cannot be laundered into AI", () => {
  const mixed = mergeLineages(
    lineageFromRootSource("USER_EXPLICIT"),
    lineageFromRootSource("SPOTIFY_RECENTLY_PLAYED"),
  );

  const evaluation = evaluateRestrictedUse(mixed, "AI");

  assert.deepEqual(evaluation.lineage.origins, ["FIRST_PARTY", "SPOTIFY"]);
  assert.equal(evaluation.decision, "DENY");
});

test("blocked restricted use never invokes the side-effect operation", () => {
  let invoked = false;
  const lineage = lineageFromRootSource("SPOTIFY_EXTENDED_HISTORY");

  assert.throws(() =>
    runRestrictedUse(lineage, "AI", () => {
      invoked = true;
      return "should-not-run";
    }),
  );

  assert.equal(invoked, false);
});

test("all current origins are fail-closed for every restricted use", () => {
  for (const origin of DATA_ORIGINS) {
    for (const use of RESTRICTED_POLICY_USES) {
      const evaluation = evaluateRestrictedUse(lineageFromOrigins([origin]), use);
      assert.notEqual(
        evaluation.decision,
        "ALLOW",
        `origin=${origin} use=${use} unexpectedly became ALLOW`,
      );
    }
  }
});
