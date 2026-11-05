import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeCalendarEventCompositionPolicy } from "./calendar-event-composition-policy";
import {
  decideEventRegeneration,
  eventRegenerationEnabled,
  eventRegenerationScheduleKey,
  narrowCalendarToEvent,
} from "./calendar-event-regeneration";
import type { CalendarDurationBlock, CalendarDurationResult } from "./google-calendar";

const TZ = "America/Sao_Paulo";
const at = (time: string) => new Date(`2026-11-05T${time}:00-03:00`);
const block = (id: string, start: string, end: string): CalendarDurationBlock => ({
  key: `0:${id}:${start}`,
  eventId: id,
  startsAt: at(start),
  endsAt: at(end),
  durationMs: at(end).getTime() - at(start).getTime(),
});
const decide = (
  blocks: CalendarDurationBlock[],
  now: string,
  finished: CalendarDurationBlock[] = [],
) =>
  decideEventRegeneration({
    blocks,
    now: at(now),
    leadMinutes: 15,
    targetPlaylistId: "carro",
    timeZone: TZ,
    finishedScheduleKeys: new Set(
      finished.map((entry) => eventRegenerationScheduleKey("carro", TZ, entry)),
    ),
  });

const A = block("a", "08:00", "08:40");
const B = block("b", "11:00", "11:30");

test("1/2: waits for the lead time, then generates only the next event", () => {
  const waiting = decide([A, B], "06:00");
  assert.equal(waiting.action, "WAIT_LEAD_TIME");
  assert.equal(waiting.action === "WAIT_LEAD_TIME" && waiting.generateAt.getTime(), at("07:45").getTime());
  const due = decide([A, B], "07:45");
  assert.equal(due.action, "GENERATE");
  assert.equal(due.action === "GENERATE" && due.event.eventId, "a");
  const second = decide([A, B], "10:45", [A]);
  assert.equal(second.action === "GENERATE" && second.event.eventId, "b");
});

test("3: an event created inside the lead time generates on the next tick", () => {
  const C = block("c", "14:30", "15:00");
  const decision = decide([C], "14:20");
  assert.equal(decision.action, "GENERATE");
  assert.equal(decision.action === "GENERATE" && decision.reason, "LEAD_TIME_REACHED");
  assert.equal(decide([C], "14:25").action, "GENERATE");
});

test("4: a cancelled event disappears; a moved event is a new key", () => {
  assert.equal(decide([B], "07:45").action, "WAIT_LEAD_TIME");
  const moved = block("a", "09:00", "09:40");
  assert.notEqual(
    eventRegenerationScheduleKey("carro", TZ, A),
    eventRegenerationScheduleKey("carro", TZ, moved),
  );
  assert.equal(decide([moved], "08:45", [A]).action, "GENERATE");
});

test("5: no event means no action, so the playlist is kept", () => {
  assert.deepEqual(decide([], "12:00"), { action: "NO_EVENT" });
  assert.deepEqual(decide([A], "09:00"), { action: "NO_EVENT" });
});

test("8: same event unchanged never generates twice", () => {
  assert.equal(decide([A, B], "07:50", [A]).action, "WAIT_CURRENT_EVENT");
  assert.equal(
    eventRegenerationScheduleKey("carro", TZ, A),
    eventRegenerationScheduleKey("carro", TZ, { ...A }),
  );
});

test("10: an in-use event is not replaced; overlapping order is deterministic", () => {
  const overlap = block("z", "08:00", "08:40");
  const first = decide([overlap, A], "07:45");
  assert.equal(first.action === "GENERATE" && first.event.eventId, "a");
  const adjacent = block("next", "08:40", "09:00");
  assert.equal(decide([A, adjacent], "08:30", [A]).action, "WAIT_CURRENT_EVENT");
  assert.equal(decide([A, adjacent], "08:41", [A]).action, "GENERATE");
});

test("an event already running but never published still generates", () => {
  const decision = decide([A], "08:10");
  assert.equal(decision.action === "GENERATE" && decision.reason, "INSIDE_LEAD_TIME_OR_STARTED");
});

test("narrowing keeps exactly one unchanged event and empties otherwise", () => {
  const calendar: CalendarDurationResult = {
    durationMs: A.durationMs + B.durationMs,
    maxEventDurationMs: A.durationMs,
    matchedEvents: 2,
    timedEvents: 2,
    filterMode: "ALL",
    marker: null,
    blocks: [A, B],
  };
  const scope = { eventId: "b", startsAt: B.startsAt.toISOString(), endsAt: B.endsAt.toISOString() };
  const narrowed = narrowCalendarToEvent(calendar, scope);
  assert.deepEqual(narrowed.blocks.map((entry) => entry.eventId), ["b"]);
  assert.equal(narrowed.durationMs, B.durationMs);
  assert.equal(narrowed.maxEventDurationMs, B.durationMs);
  const moved = narrowCalendarToEvent(calendar, { ...scope, startsAt: A.startsAt.toISOString() });
  assert.equal(moved.durationMs, 0);
  assert.equal(moved.blocks.length, 0);
});

test("policy: opt-in, only 5/15/30, legacy snapshots never carry it", () => {
  const base = {
    eventCompositionPolicy: "SEQUENCE_PER_EVENT" as const,
    maxPodcastsPerEvent: 1,
    podcastEventSafetyMarginSeconds: 0,
    podcastEventDistribution: "EVERY_EVENT" as const,
  };
  const off = normalizeCalendarEventCompositionPolicy("carro", { ...base, eventRegenerationLeadMinutes: 30 });
  assert.equal("eventRegeneration" in off.sequencePerEvent!, false);
  const on = normalizeCalendarEventCompositionPolicy("carro", { ...base, regenerateOnEvent: true });
  assert.deepEqual(on.sequencePerEvent?.eventRegeneration, { leadMinutes: 15 });
  assert.throws(() =>
    normalizeCalendarEventCompositionPolicy("carro", {
      ...base, regenerateOnEvent: true, eventRegenerationLeadMinutes: 10,
    }),
  );
  const legacy = normalizeCalendarEventCompositionPolicy("carro", {
    ...base, eventCompositionPolicy: "PODCAST_THEN_MUSIC", regenerateOnEvent: true,
  });
  assert.equal("sequencePerEvent" in legacy, false);
});

test("switch is literal and the scheduler keeps both triggers exclusive", () => {
  assert.equal(eventRegenerationEnabled({}), false);
  assert.equal(eventRegenerationEnabled({ CALENDAR_05_EVENT_REGENERATION_MODE: "ACTIVE" }), true);
  const scheduler = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  const eventBranch = scheduler.indexOf("const leadMinutes = leadMinutesByTargetId.get(target.id);");
  const dailyDue = scheduler.indexOf("if (!slot.due) continue;");
  assert.ok(eventBranch > 0 && dailyDue > eventBranch, "event branch runs before the daily slot");
  const branch = scheduler.slice(eventBranch, dailyDue);
  assert.match(branch, /processed \+= 1;\s*continue;/);
  assert.match(branch, /if \(!due\) continue;/);
  const generator = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  assert.match(generator, /emptyCalendarBehavior === "CLEAR" && !eventScope/);
});
