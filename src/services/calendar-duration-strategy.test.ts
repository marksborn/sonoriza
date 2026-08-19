import assert from "node:assert/strict";
import test from "node:test";

import type {
  CalendarDurationResult,
} from "@/services/google-calendar";

import {
  calendarDurationPlanningBlocks,
} from "./calendar-duration-strategy";

function calendar(): CalendarDurationResult {
  return {
    durationMs: 71 * 60_000,
    maxEventDurationMs: 36 * 60_000,
    matchedEvents: 2,
    timedEvents: 2,
    filterMode: "ALL",
    marker: null,
    blocks: [
      {
        key: "0:ida",
        eventId: "ida",
        startsAt: new Date(
          "2026-08-19T11:00:00.000Z",
        ),
        endsAt: new Date(
          "2026-08-19T11:35:00.000Z",
        ),
        durationMs: 35 * 60_000,
      },
      {
        key: "0:volta",
        eventId: "volta",
        startsAt: new Date(
          "2026-08-19T17:00:00.000Z",
        ),
        endsAt: new Date(
          "2026-08-19T17:36:00.000Z",
        ),
        durationMs: 36 * 60_000,
      },
    ],
  };
}

test(
  "CALENDAR-02 SUMMED preserves the legacy single-budget path",
  () => {
    assert.equal(
      calendarDurationPlanningBlocks(
        "SUMMED",
        calendar(),
      ),
      undefined,
    );
  },
);

test(
  "CALENDAR-02 PER_EVENT converts each calendar event into an independent planner budget",
  () => {
    const blocks =
      calendarDurationPlanningBlocks(
        "PER_EVENT",
        calendar(),
      );

    assert.deepEqual(
      blocks?.map((block) => ({
        key: block.key,
        minutes:
          block.targetDurationMs /
          60_000,
        eventId: block.eventId,
      })),
      [
        {
          key: "0:ida",
          minutes: 35,
          eventId: "ida",
        },
        {
          key: "0:volta",
          minutes: 36,
          eventId: "volta",
        },
      ],
    );

    assert.equal(
      blocks?.[0]?.startsAt,
      "2026-08-19T11:00:00.000Z",
    );

    assert.equal(
      blocks?.[1]?.endsAt,
      "2026-08-19T17:36:00.000Z",
    );
  },
);

test(
  "CALENDAR-02 PER_EVENT without calendar data cannot invent blocks",
  () => {
    assert.equal(
      calendarDurationPlanningBlocks(
        "PER_EVENT",
        null,
      ),
      undefined,
    );
  },
);
