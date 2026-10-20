import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveTargetCalendarScope } from "./target-calendar-selection";

test("KEEP_FILLED SELECTED scope uses Carro calendar, never 16h legacy globals", () => {
  const targetCalendar = "calendar-carro";
  const legacyDurationCalendarIds = [
    "calendar-work",
    targetCalendar,
    "calendar-personal",
  ];
  const selected = resolveTargetCalendarScope({
    mode: "SELECTED",
    selectedGoogleCalendarIds: [targetCalendar],
    queryableCalendarIds: legacyDurationCalendarIds,
    legacyDurationCalendarIds,
  });
  assert.deepEqual(selected.calendarIds, [targetCalendar]);

  const legacy = resolveTargetCalendarScope({
    mode: "LEGACY_GLOBAL",
    selectedGoogleCalendarIds: [targetCalendar],
    queryableCalendarIds: legacyDurationCalendarIds,
    legacyDurationCalendarIds,
  });
  assert.equal(legacy.calendarIds.length, 3);
  assert.notDeepEqual(selected.calendarIds, legacy.calendarIds);
});

test("KEEP_FILLED preparation resolves calendar scopes without falling back to legacy", () => {
  const source = readFileSync("src/services/keep-filled-maintenance.ts", "utf8");
  assert.match(
    source,
    /const durationCalendarIds = durationCalendarIdsOverride[\s\S]*?: await resolveKeepFilledTargetCalendarIds\(userId, target\);/,
  );
  assert.match(source, /prisma\.targetPlaylistCalendar\.findMany/);
  assert.match(source, /const scope = resolveTargetCalendarScope\(/);
  assert.match(source, /if \(scope\.calendarIds\.length === 0\) \{/);
});
