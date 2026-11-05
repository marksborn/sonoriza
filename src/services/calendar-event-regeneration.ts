import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { computeCalendarDuration } from "@/services/google-calendar";
import type { CalendarDurationBlock, CalendarDurationResult } from "@/services/google-calendar";
import { resolveTargetCalendarScope } from "@/services/target-calendar-selection";

/**
 * CALENDAR-05 (#553): the calendar replaces the daily schedule as the automatic
 * trigger of a target. This changes WHEN a target is generated and WHICH single
 * event it covers; composition stays with the existing engine.
 *
 * Opt-in per target (Sequência por evento) plus the operator switch
 * CALENDAR_05_EVENT_REGENERATION_MODE=ACTIVE. With the switch off the saved
 * daily schedule keeps running, so it is also the rollback.
 *
 * Reuses TargetScheduleRun with one scheduleKey per event fingerprint, which
 * inherits claim idempotency, retries and restart takeover.
 */

export const EVENT_REGENERATION_SCHEDULE_MARKER = ":event:";

export function eventRegenerationEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.CALENDAR_05_EVENT_REGENERATION_MODE?.trim() === "ACTIVE";
}

export type EventScope = Readonly<{
  eventId: string;
  startsAt: string;
  endsAt: string;
}>;

/** Same event unchanged = same key, however often the calendar is polled. */
export function eventRegenerationScheduleKey(
  targetPlaylistId: string,
  timeZone: string,
  event: Pick<CalendarDurationBlock, "eventId" | "startsAt" | "endsAt">,
): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        targetPlaylistId,
        event.eventId,
        event.startsAt.toISOString(),
        event.endsAt.toISOString(),
        timeZone,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${targetPlaylistId}${EVENT_REGENERATION_SCHEDULE_MARKER}${fingerprint}`;
}

export type EventRegenerationDecision =
  | Readonly<{ action: "GENERATE"; event: CalendarDurationBlock; scheduleKey: string; reason: "LEAD_TIME_REACHED" | "INSIDE_LEAD_TIME_OR_STARTED" }>
  | Readonly<{ action: "WAIT_LEAD_TIME"; event: CalendarDurationBlock; generateAt: Date }>
  | Readonly<{ action: "WAIT_CURRENT_EVENT"; event: CalendarDurationBlock }>
  | Readonly<{ action: "NO_EVENT" }>;

/**
 * Deterministic: events in global chronology, one at a time. An event whose
 * run already finished holds the playlist until it ends, so a following event
 * never replaces content that is in use. No event means no action: the current
 * playlist is kept.
 */
export function decideEventRegeneration(input: {
  blocks: readonly CalendarDurationBlock[];
  now: Date;
  leadMinutes: number;
  targetPlaylistId: string;
  timeZone: string;
  finishedScheduleKeys: ReadonlySet<string>;
}): EventRegenerationDecision {
  const nowMs = input.now.getTime();
  const leadMs = input.leadMinutes * 60_000;
  const ordered = input.blocks
    .filter((block) => block.durationMs > 0 && block.endsAt.getTime() > nowMs)
    .sort(
      (a, b) =>
        a.startsAt.getTime() - b.startsAt.getTime() ||
        a.endsAt.getTime() - b.endsAt.getTime() ||
        a.key.localeCompare(b.key),
    );
  const event = ordered[0];
  if (!event) return { action: "NO_EVENT" };

  const scheduleKey = eventRegenerationScheduleKey(
    input.targetPlaylistId,
    input.timeZone,
    event,
  );
  if (input.finishedScheduleKeys.has(scheduleKey)) {
    return { action: "WAIT_CURRENT_EVENT", event };
  }

  const generateAtMs = event.startsAt.getTime() - leadMs;
  if (nowMs < generateAtMs) {
    return { action: "WAIT_LEAD_TIME", event, generateAt: new Date(generateAtMs) };
  }
  return {
    action: "GENERATE",
    event,
    scheduleKey,
    // A tick lands up to 5 minutes after the exact lead time.
    reason:
      nowMs - generateAtMs <= 5 * 60_000 ? "LEAD_TIME_REACHED" : "INSIDE_LEAD_TIME_OR_STARTED",
  };
}

/** Narrows a day's calendar to one event; empty when it no longer exists unchanged. */
export function narrowCalendarToEvent(
  calendar: CalendarDurationResult,
  scope: EventScope,
): CalendarDurationResult {
  const block = calendar.blocks.find(
    (entry) =>
      entry.eventId === scope.eventId &&
      entry.startsAt.toISOString() === scope.startsAt &&
      entry.endsAt.toISOString() === scope.endsAt,
  );
  return {
    ...calendar,
    durationMs: block?.durationMs ?? 0,
    maxEventDurationMs: block?.durationMs ?? 0,
    matchedEvents: block ? 1 : 0,
    blocks: block ? [block] : [],
  };
}

export type EventRegenerationTarget = Readonly<{
  id: string;
  calendarMode: "LEGACY_GLOBAL" | "SELECTED" | "ALL_QUERYABLE";
  calendarEventFilterMode: "ALL" | "MARKER";
  calendarEventMarker: string | null;
}>;

/** Today's events plus tomorrow's when the lead time crosses midnight. */
export async function loadEventRegenerationBlocks(
  userId: string,
  target: EventRegenerationTarget,
  now: Date,
  leadMinutes: number,
): Promise<CalendarDurationBlock[]> {
  const [queryable, linked] = await Promise.all([
    prisma.calendarSelection.findMany({
      where: { userId, selected: true },
      select: { googleCalendarId: true, usedForDuration: true },
    }),
    prisma.targetPlaylistCalendar.findMany({
      where: { targetPlaylistId: target.id },
      select: {
        calendarSelection: { select: { googleCalendarId: true, selected: true, userId: true } },
      },
    }),
  ]);
  const scope = resolveTargetCalendarScope({
    mode: target.calendarMode,
    selectedGoogleCalendarIds: linked
      .filter((row) => row.calendarSelection.userId === userId && row.calendarSelection.selected)
      .map((row) => row.calendarSelection.googleCalendarId),
    queryableCalendarIds: queryable.map((row) => row.googleCalendarId),
    legacyDurationCalendarIds: queryable
      .filter((row) => row.usedForDuration)
      .map((row) => row.googleCalendarId),
  });
  const filter = { mode: target.calendarEventFilterMode, marker: target.calendarEventMarker };
  const today = await computeCalendarDuration(userId, scope.calendarIds, now, filter);
  const horizon = new Date(now.getTime() + leadMinutes * 60_000);
  if (horizon.toDateString() === now.toDateString()) return today.blocks;
  const tomorrow = await computeCalendarDuration(userId, scope.calendarIds, horizon, filter);
  return [...today.blocks, ...tomorrow.blocks];
}
