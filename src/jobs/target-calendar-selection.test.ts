import assert from "node:assert/strict";
import test from "node:test";

import {
  requiresExplicitTargetCalendar,
  resolveTargetCalendarScope,
} from "@/services/target-calendar-selection";

test("explicit target calendar ignores the legacy global duration set", () => {
  assert.deepEqual(
    resolveTargetCalendarScope("calendar-work", ["calendar-personal", "calendar-trip"]),
    {
      mode: "EXPLICIT",
      calendarIds: ["calendar-work"],
    },
  );
});

test("unbound target preserves the legacy global duration calendars", () => {
  const legacy = ["calendar-personal", "calendar-trip"];

  assert.deepEqual(resolveTargetCalendarScope(null, legacy), {
    mode: "LEGACY_GLOBAL",
    calendarIds: legacy,
  });
});

test("compatibility seam never invents a default calendar", () => {
  assert.deepEqual(resolveTargetCalendarScope(undefined, []), {
    mode: "LEGACY_GLOBAL",
    calendarIds: [],
  });
});

test("new calendar target requires an explicit calendar selection", () => {
  assert.equal(
    requiresExplicitTargetCalendar({
      durationMode: "CALENDAR",
      isNewTarget: true,
      calendarSelectionId: null,
    }),
    true,
  );
  assert.equal(
    requiresExplicitTargetCalendar({
      durationMode: "CALENDAR",
      isNewTarget: true,
      calendarSelectionId: "selection-1",
    }),
    false,
  );
});

test("existing targets may remain legacy and fixed targets need no calendar", () => {
  assert.equal(
    requiresExplicitTargetCalendar({
      durationMode: "CALENDAR",
      isNewTarget: false,
      calendarSelectionId: null,
    }),
    false,
  );
  assert.equal(
    requiresExplicitTargetCalendar({
      durationMode: "FIXED",
      isNewTarget: true,
      calendarSelectionId: null,
    }),
    false,
  );
});
