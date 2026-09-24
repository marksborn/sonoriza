import assert from "node:assert/strict";
import test from "node:test";

import type { Gate4CComponentCollisionSample } from "./canonical-consumer-dedupe-shadow";
import {
  selectGate4DRepresentative,
  type Gate4DOrderedOccurrence,
} from "./canonical-representative-selection-shadow";

function collision(
  componentId: string,
  members: string[],
  options: {
    preferenceState?: Gate4CComponentCollisionSample["preferenceState"];
    containsExcludedPreference?: boolean;
  } = {},
): Gate4CComponentCollisionSample {
  const sorted = [...members].sort();
  return {
    componentId,
    componentDecision: "SAFE_CANONICAL_COMPONENT",
    preferenceState: options.preferenceState ?? "NO_EXPLICIT_TRACK_PREFERENCE",
    containsExcludedPreference: options.containsExcludedPreference ?? false,
    memberProviderTrackIdsPresent: sorted,
    allMemberProviderTrackIds: sorted,
    memberSources: sorted.map((providerTrackId) => ({
      providerTrackId,
      sourcePlaylistIds: ["source-a"],
    })),
    legacyDistinctProviderTracks: sorted.length,
    hypotheticalCanonicalRecordingKeys: 1,
    hypotheticalReduction: sorted.length - 1,
    decision: "WOULD_COLLAPSE_COMPONENT",
    representativeProviderTrackId: null,
    representativeSelection: "NOT_SELECTED_IN_GATE4C",
  };
}

function occurrence(
  providerTrackId: string,
  sourcePlaylistId: string,
  sourceOrder: number,
  cachePosition: number,
): Gate4DOrderedOccurrence {
  return {
    providerTrackId,
    sourcePlaylistId,
    sourceOrder,
    cachePosition,
    uri: `spotify:track:${providerTrackId}`,
  };
}

test("LEGACY_FIRST_OCCURRENCE_V1 prefers effective source order before cache position", () => {
  const result = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: collision("component-a", ["track-a", "track-b"]),
    occurrences: [
      occurrence("track-a", "source-b", 1, 0),
      occurrence("track-b", "source-a", 0, 999),
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.representativeProviderTrackId, "track-b");
  assert.deepEqual(result.selection.droppedProviderTrackIds, ["track-a"]);
  assert.equal(result.selection.decisiveCriterion, "SOURCE_ORDER");
  assert.equal(result.selection.policy, "LEGACY_FIRST_OCCURRENCE_V1");
  assert.equal(result.selection.decision, "WOULD_KEEP_DROP");
});

test("cache array position decides aliases in the same effective source", () => {
  const result = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: collision("component-a", ["track-a", "track-b"]),
    occurrences: [
      occurrence("track-a", "source-a", 0, 17),
      occurrence("track-b", "source-a", 0, 4),
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.representativeProviderTrackId, "track-b");
  assert.equal(result.selection.decisiveCriterion, "CACHE_POSITION");
});

test("provider ID is only a final deterministic tie break", () => {
  const result = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: collision("component-a", ["z-track", "a-track"]),
    occurrences: [
      occurrence("z-track", "source-a", 0, 4),
      occurrence("a-track", "source-a", 0, 4),
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.representativeProviderTrackId, "a-track");
  assert.equal(result.selection.decisiveCriterion, "PROVIDER_TRACK_ID_TIE_BREAK");
});

test("the earliest occurrence of one provider track is used when it appears in multiple sources", () => {
  const result = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: collision("component-a", ["track-a", "track-b"]),
    occurrences: [
      occurrence("track-a", "source-c", 2, 1),
      occurrence("track-a", "source-a", 0, 30),
      occurrence("track-b", "source-b", 1, 0),
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.representativeProviderTrackId, "track-a");
  assert.equal(result.selection.representativeOccurrence.sourcePlaylistId, "source-a");
  assert.equal(result.selection.representativeAppearsInMultipleSources, true);
});

test("same ordered snapshot always produces the same representative and reason chain", () => {
  const rows = [
    occurrence("track-b", "source-a", 0, 8),
    occurrence("track-a", "source-a", 0, 2),
  ];
  const sample = collision("component-a", ["track-a", "track-b"]);

  const first = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: sample,
    occurrences: rows,
  });
  const second = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: sample,
    occurrences: [...rows],
  });

  assert.deepEqual(first, second);
});

test("three aliases produce exactly one KEEP and N-1 hypothetical DROP", () => {
  const result = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: collision("component-a", ["a", "b", "c"]),
    occurrences: [
      occurrence("a", "source-a", 0, 3),
      occurrence("b", "source-a", 0, 5),
      occurrence("c", "source-b", 1, 0),
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.representativeProviderTrackId, "a");
  assert.deepEqual(result.selection.droppedProviderTrackIds, ["b", "c"]);
  assert.equal(result.selection.hypotheticalDrops, 2);
});

test("identical explicit preference is carried as evidence but never changes ordering", () => {
  const result = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: collision("component-a", ["preferred-looking", "first"], {
      preferenceState: "IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
    }),
    occurrences: [
      occurrence("preferred-looking", "source-a", 0, 12),
      occurrence("first", "source-a", 0, 2),
    ],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.representativeProviderTrackId, "first");
  assert.equal(
    result.selection.preferenceState,
    "IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
  );
});

test("consumer occupancy drift fails closed rather than selecting a representative", () => {
  const result = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: collision("component-a", ["track-a", "track-b"]),
    occurrences: [occurrence("track-a", "source-a", 0, 0)],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /occupancy changed/);
});

test("selection is pure and does not mutate ordered occurrences", () => {
  const rows = [
    occurrence("track-b", "source-a", 0, 3),
    occurrence("track-a", "source-a", 0, 1),
  ];
  const before = structuredClone(rows);
  const result = selectGate4DRepresentative({
    targetPlaylistId: "target-a",
    targetName: "Target A",
    collision: collision("component-a", ["track-a", "track-b"]),
    occurrences: rows,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(rows, before);
});
