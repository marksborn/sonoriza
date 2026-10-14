import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  readManualKeepFilledNoop,
  resolveManualKeepFilledCalendarIds,
} from "./manual-keep-filled-calendar-scope";

const base = {
  durationMode: "CALENDAR" as const,
  calendarMode: "SELECTED" as const,
  selectedGoogleCalendarIds: ["gym-calendar", "gym-calendar"],
  invalidLinkedCalendarCount: 0,
  queryableCalendarIds: ["all-calendar", "gym-calendar"],
  legacyDurationCalendarIds: ["legacy-calendar"],
};

test("#460 selected calendar for Academia is used exactly and deduplicated", () => {
  assert.deepEqual(resolveManualKeepFilledCalendarIds(base), ["gym-calendar"]);
});

test("#460 ALL_QUERYABLE and LEGACY_GLOBAL preserve their distinct scopes", () => {
  assert.deepEqual(resolveManualKeepFilledCalendarIds({
    ...base, calendarMode: "ALL_QUERYABLE",
  }), ["all-calendar", "gym-calendar"]);
  assert.deepEqual(resolveManualKeepFilledCalendarIds({
    ...base, calendarMode: "LEGACY_GLOBAL",
  }), ["legacy-calendar"]);
});

test("#460 no selected calendar / invalid account link fails closed", () => {
  assert.throws(() => resolveManualKeepFilledCalendarIds({
    ...base, selectedGoogleCalendarIds: [],
  }), /seleção de calendários vazia/);
  assert.throws(() => resolveManualKeepFilledCalendarIds({
    ...base, invalidLinkedCalendarCount: 1,
  }), /desmarcados ou de outra conta/);
  assert.throws(() => resolveManualKeepFilledCalendarIds({
    ...base, calendarMode: "ALL_QUERYABLE", queryableCalendarIds: [],
  }), /sem calendários elegíveis/);
});

test("#460 FIXED mode does not ask Google Calendar for duration", () => {
  assert.deepEqual(resolveManualKeepFilledCalendarIds({
    ...base, durationMode: "FIXED", selectedGoogleCalendarIds: [],
  }), []);
});

test("#460 no-op summary is not evidence for a successful Reserve plan", () => {
  for (const mode of ["KEEP", "SKIP"] as const) {
    const summary = {
      qualityPassed: false,
      manualKeepFilledNoop: {
        reason: "CALENDAR_EMPTY_" + mode,
        spotifyWrites: false,
        realRunApprovalEligible: false,
      },
    };
    assert.equal(readManualKeepFilledNoop(summary), mode);
    assert.equal(readManualKeepFilledNoop({
      manualKeepFilledNoop: { ...summary.manualKeepFilledNoop, realRunApprovalEligible: true },
    }), null);
  }
  assert.equal(readManualKeepFilledNoop(null), null);
});

test("#460 manual endpoint prepares ONLY explicitly selected KEEP_FILLED target", () => {
  const api = readFileSync("src/app/api/generate/route.ts", "utf8");
  assert.match(api, /targetPlaylistIds\.length === 1 && ownedTargets\[0\]\?\.updatePolicy === "KEEP_FILLED"/);
  assert.match(api, /prepareManualKeepFilledTarget\(/);
  assert.match(api, /recordManualKeepFilledNoop\(/);
  assert.match(api, /manualKeepFilledPreflight\?\.kind === "READY"[\s\S]*?date: preparationDate/);
  assert.match(api, /KEEP_FILLED_PREPARATION_FAILED/);
});

test("#460 sim and real manual generation both pass server-only snapshots and sharing fences", () => {
  const prep = readFileSync("src/services/manual-keep-filled-generation.ts", "utf8");
  assert.match(prep, /prepareKeepFilledTarget\([\s\S]*?durationCalendarIds/);
  assert.match(prep, /snapshotBefore/);
  assert.match(prep, /reservedTargetSnapshots\[outside.spotifyPlaylistId\] = state.snapshotId/);
  assert.match(prep, /externalReservationsByUri/);
  assert.match(prep, /qualityPassed: false/);
  assert.match(prep, /realRunApprovalEligible: false/);
});
