import assert from "node:assert/strict";
import test from "node:test";

import { lineageFromOrigins } from "../data-policy/provenance";
import {
  assertConfidenceBasisPoints,
  assertProviderRefAssociationStable,
  isExecutableTrackProviderRef,
  normalizeIsrcEvidence,
  normalizeProviderEntityId,
  normalizeProviderKey,
  providerRefNaturalKey,
  singletonBootstrapResolution,
} from "./contracts";

test("provider keys are canonicalized while external IDs preserve case", () => {
  assert.equal(normalizeProviderKey(" Spotify "), "spotify");
  assert.equal(normalizeProviderEntityId(" AbC123 "), "AbC123");
  assert.throws(() => normalizeProviderKey("   "), /must not be empty/);
  assert.throws(() => normalizeProviderEntityId("   "), /must not be empty/);
});

test("ISRC normalization produces evidence without declaring identity equivalence", () => {
  assert.equal(normalizeIsrcEvidence("US-ABC-12-34567"), "USABC1234567");
  assert.equal(normalizeIsrcEvidence("usabc1234567"), "USABC1234567");
  assert.equal(normalizeIsrcEvidence(null), null);
  assert.equal(normalizeIsrcEvidence("---"), null);
});

test("confidence is constrained to integer basis points", () => {
  assert.equal(assertConfidenceBasisPoints(0), 0);
  assert.equal(assertConfidenceBasisPoints(10_000), 10_000);
  assert.throws(() => assertConfidenceBasisPoints(-1), /0 to 10000/);
  assert.throws(() => assertConfidenceBasisPoints(10_001), /0 to 10000/);
  assert.throws(() => assertConfidenceBasisPoints(1.5), /integer/);
});

test("provider-ref natural keys are scoped by user", () => {
  const first = providerRefNaturalKey({
    userId: "user-a",
    provider: "SPOTIFY",
    providerEntityId: "track-1",
  });
  const same = providerRefNaturalKey({
    userId: "user-a",
    provider: "spotify",
    providerEntityId: "track-1",
  });
  const otherUser = providerRefNaturalKey({
    userId: "user-b",
    provider: "spotify",
    providerEntityId: "track-1",
  });

  assert.equal(first, same);
  assert.notEqual(first, otherUser);
});

test("canonical identity alone never makes a track provider ref executable", () => {
  assert.equal(
    isExecutableTrackProviderRef({
      executionStatus: "KNOWN",
      providerTrackId: "track-1",
      uri: "spotify:track:track-1",
    }),
    false,
  );

  assert.equal(
    isExecutableTrackProviderRef({
      executionStatus: "EXECUTABLE",
      providerTrackId: "track-1",
      uri: null,
    }),
    false,
  );

  assert.equal(
    isExecutableTrackProviderRef({
      executionStatus: "EXECUTABLE",
      providerTrackId: "   ",
      uri: "spotify:track:track-1",
    }),
    false,
  );

  assert.equal(
    isExecutableTrackProviderRef({
      executionStatus: "EXECUTABLE",
      providerTrackId: "track-1",
      uri: "spotify:track:track-1",
    }),
    true,
  );
});

test("provider-ref association cannot be silently moved to another identity", () => {
  const current = {
    userId: "user-a",
    provider: "spotify",
    providerEntityId: "track-1",
    canonicalIdentityId: "recording-a",
  } as const;

  assert.doesNotThrow(() =>
    assertProviderRefAssociationStable(current, {
      ...current,
      provider: "SPOTIFY",
    }),
  );

  assert.throws(
    () =>
      assertProviderRefAssociationStable(current, {
        ...current,
        canonicalIdentityId: "recording-b",
      }),
    /explicit merge\/split/,
  );

  assert.throws(
    () =>
      assertProviderRefAssociationStable(current, {
        ...current,
        providerEntityId: "track-2",
      }),
    /natural key is immutable/,
  );
});

test("singleton bootstrap is deterministic and preserves existing provenance lineage", () => {
  const lineage = lineageFromOrigins(["SPOTIFY"]);

  assert.deepEqual(singletonBootstrapResolution(lineage), {
    status: "NEW",
    reason: "SINGLETON_BOOTSTRAP",
    confidenceBasisPoints: 10_000,
    lineage: { origins: ["SPOTIFY"] },
  });
});
