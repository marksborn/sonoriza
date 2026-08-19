import assert from "node:assert/strict";
import test from "node:test";

import type { CalendarEvent } from "./client";
import { buildCalendarDurationBlocks } from "./duration";

function event(id: string, start: string, end: string): CalendarEvent {
  return {
    id,
    summary: id,
    description: null,
    start: new Date(start),
    end: new Date(end),
    allDay: false,
  };
}

test("CALENDAR-02 orders eligible events globally across calendars", () => {
  const blocks = buildCalendarDurationBlocks([
    {
      calendarIndex: 0,
      event: event("later", "2026-08-19T13:00:00.000Z", "2026-08-19T13:36:00.000Z"),
    },
    {
      calendarIndex: 1,
      event: event("earlier", "2026-08-19T11:00:00.000Z", "2026-08-19T11:35:00.000Z"),
    },
  ]);

  assert.deepEqual(
    blocks.map((block) => ({ id: block.eventId, minutes: block.durationMs / 60_000 })),
    [
      { id: "earlier", minutes: 35 },
      { id: "later", minutes: 36 },
    ],
  );
});

test("CALENDAR-02 keeps block keys unique when provider event ids repeat across calendars", () => {
  const sameStart = "2026-08-19T11:00:00.000Z";
  const sameEnd = "2026-08-19T11:35:00.000Z";
  const blocks = buildCalendarDurationBlocks([
    { calendarIndex: 0, event: event("same-id", sameStart, sameEnd) },
    { calendarIndex: 1, event: event("same-id", sameStart, sameEnd) },
  ]);

  assert.equal(blocks.length, 2);
  assert.notEqual(blocks[0]?.key, blocks[1]?.key);
  assert.deepEqual(blocks.map((block) => block.key), [
    `0:same-id:${sameStart}`,
    `1:same-id:${sameStart}`,
  ]);
});
