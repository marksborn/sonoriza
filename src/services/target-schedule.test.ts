import assert from "node:assert/strict";
import test from "node:test";

import {
  dailyScheduleSlot,
  formatScheduleTime,
  isValidTimeZone,
  nextScheduleLabel,
  parseScheduleTime,
} from "./target-schedule";

test("daily schedule is evaluated in the configured IANA timezone", () => {
  const before = dailyScheduleSlot(
    "target-1",
    8 * 60 + 30,
    "America/Sao_Paulo",
    new Date("2026-08-11T11:29:00.000Z"),
  );
  assert.equal(before.localDate, "2026-08-11");
  assert.equal(before.localMinutes, 8 * 60 + 29);
  assert.equal(before.due, false);

  const at = dailyScheduleSlot(
    "target-1",
    8 * 60 + 30,
    "America/Sao_Paulo",
    new Date("2026-08-11T11:30:00.000Z"),
  );
  assert.equal(at.due, true);
  assert.equal(at.scheduleKey, "target-1:2026-08-11");
});

test("a missed exact minute remains due later on the same local day", () => {
  const slot = dailyScheduleSlot(
    "target-2",
    7 * 60,
    "Europe/Lisbon",
    new Date("2026-08-11T15:00:00.000Z"),
  );
  assert.equal(slot.due, true);
});

test("schedule keys roll over by local date instead of UTC date", () => {
  const slot = dailyScheduleSlot(
    "target-3",
    23 * 60,
    "America/Sao_Paulo",
    new Date("2026-08-12T01:30:00.000Z"),
  );
  assert.equal(slot.localDate, "2026-08-11");
  assert.equal(slot.scheduleKey, "target-3:2026-08-11");
});

test("time parsing and formatting stay strict", () => {
  assert.equal(parseScheduleTime("08:05"), 485);
  assert.equal(parseScheduleTime("24:00"), null);
  assert.equal(parseScheduleTime("8:05"), null);
  assert.equal(formatScheduleTime(485), "08:05");
});

test("timezone validation rejects unknown zones", () => {
  assert.equal(isValidTimeZone("America/Sao_Paulo"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
});

test("next label distinguishes today's pending slot from tomorrow", () => {
  const now = new Date("2026-08-11T10:00:00.000Z");
  assert.match(
    nextScheduleLabel(8 * 60, "America/Sao_Paulo", now, false),
    /^hoje, 08:00/,
  );
  assert.match(
    nextScheduleLabel(8 * 60, "America/Sao_Paulo", now, true),
    /^amanhã, 08:00/,
  );
});
