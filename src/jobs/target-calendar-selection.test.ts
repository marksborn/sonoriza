import assert from "node:assert/strict";
import test from "node:test";

import {
  canPreserveLegacyTargetCalendar,
  normalizeTargetCalendarSelectionIds,
  resolveTargetCalendarScope,
  targetCalendarScopesEqual,
} from "@/services/target-calendar-selection";

test("selected mode uses one or many explicit calendars and deduplicates identity", () => {
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "SELECTED",
      selectedGoogleCalendarIds: ["work", "personal", "work"],
      queryableCalendarIds: ["work", "personal", "travel"],
      legacyDurationCalendarIds: ["legacy"],
    }),
    {
      mode: "SELECTED",
      calendarIds: ["personal", "work"],
    },
  );
});

test("all-queryable mode dynamically follows the complete queryable set", () => {
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "ALL_QUERYABLE",
      selectedGoogleCalendarIds: ["work"],
      queryableCalendarIds: ["travel", "personal", "work"],
      legacyDurationCalendarIds: ["legacy"],
    }),
    {
      mode: "ALL_QUERYABLE",
      calendarIds: ["personal", "travel", "work"],
    },
  );
});

test("legacy mode preserves only the old global duration set", () => {
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "LEGACY_GLOBAL",
      selectedGoogleCalendarIds: ["work"],
      queryableCalendarIds: ["work", "personal"],
      legacyDurationCalendarIds: ["legacy-b", "legacy-a"],
    }),
    {
      mode: "LEGACY_GLOBAL",
      calendarIds: ["legacy-a", "legacy-b"],
    },
  );
});

test("explicit modes never invent legacy fallback when their set is empty", () => {
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "SELECTED",
      selectedGoogleCalendarIds: [],
      queryableCalendarIds: ["queryable"],
      legacyDurationCalendarIds: ["legacy"],
    }),
    { mode: "SELECTED", calendarIds: [] },
  );
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "ALL_QUERYABLE",
      selectedGoogleCalendarIds: ["selected"],
      queryableCalendarIds: [],
      legacyDurationCalendarIds: ["legacy"],
    }),
    { mode: "ALL_QUERYABLE", calendarIds: [] },
  );
});

test("only an already calendar-driven legacy target may preserve legacy mode", () => {
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "CALENDAR",
      calendarMode: "LEGACY_GLOBAL",
    }),
    true,
  );
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "FIXED",
      calendarMode: "LEGACY_GLOBAL",
    }),
    false,
  );
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "CALENDAR",
      calendarMode: "SELECTED",
    }),
    false,
  );
  assert.equal(canPreserveLegacyTargetCalendar(null), false);
});

test("scope comparison is deterministic regardless of original selection order", () => {
  const left = resolveTargetCalendarScope({
    mode: "SELECTED",
    selectedGoogleCalendarIds: ["b", "a"],
    queryableCalendarIds: [],
    legacyDurationCalendarIds: [],
  });
  const right = resolveTargetCalendarScope({
    mode: "SELECTED",
    selectedGoogleCalendarIds: normalizeTargetCalendarSelectionIds(["a", "b"]),
    queryableCalendarIds: [],
    legacyDurationCalendarIds: [],
  });
  assert.equal(targetCalendarScopesEqual(left, right), true);
});
