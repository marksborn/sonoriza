import { GoogleCalendarClient, type CalendarEvent } from "./client";

export interface DayBounds {
  from: Date;
  to: Date;
}

export type CalendarEventFilterMode = "ALL" | "MARKER";

export interface CalendarEventFilter {
  mode: CalendarEventFilterMode;
  marker?: string | null;
}

export interface CalendarDurationBlock {
  key: string;
  eventId: string;
  startsAt: Date;
  endsAt: Date;
  durationMs: number;
}

export interface CalendarDurationResult {
  durationMs: number;
  maxEventDurationMs: number;
  matchedEvents: number;
  timedEvents: number;
  filterMode: CalendarEventFilterMode;
  marker: string | null;
  /** CALENDAR-02: eligible timed events in deterministic global chronology. */
  blocks: CalendarDurationBlock[];
}

/** [start of day, start of next day) for the given date. */
export function dayBounds(date: Date): DayBounds {
  const from = new Date(date);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

function normalizedMarker(marker: string | null | undefined): string | null {
  const value = marker?.trim();
  return value ? value.toLocaleLowerCase("pt-BR") : null;
}

/** Returns whether an event is eligible for a configured calendar filter. */
export function matchesCalendarEventFilter(
  event: CalendarEvent,
  filter: CalendarEventFilter,
): boolean {
  if (event.allDay) return false;
  if (filter.mode === "ALL") return true;

  const marker = normalizedMarker(filter.marker);
  if (!marker) return false;

  const searchable = `${event.summary ?? ""}\n${event.description ?? ""}`.toLocaleLowerCase(
    "pt-BR",
  );
  return searchable.includes(marker);
}

/** Total milliseconds covered by eligible timed events. */
export function sumTimedDurationMs(
  events: CalendarEvent[],
  filter: CalendarEventFilter = { mode: "ALL" },
): number {
  return events
    .filter((event) => matchesCalendarEventFilter(event, filter))
    .reduce(
      (acc, event) =>
        acc + Math.max(0, event.end.getTime() - event.start.getTime()),
      0,
    );
}

/** Largest individual eligible timed event, in milliseconds. */
export function maxTimedDurationMs(
  events: CalendarEvent[],
  filter: CalendarEventFilter = { mode: "ALL" },
): number {
  return events
    .filter((event) => matchesCalendarEventFilter(event, filter))
    .reduce(
      (max, event) =>
        Math.max(max, Math.max(0, event.end.getTime() - event.start.getTime())),
      0,
    );
}

/**
 * Resolves calendar-driven duration for a day across calendars enabled for
 * duration, while also returning audit metadata for CONFIG-04 / CALENDAR-02.
 *
 * MARKER mode is intentionally literal: Sonoriza only checks title and
 * description for the configured text and sums the event duration. It does not
 * infer the event meaning.
 */
export async function computeCalendarDuration(
  userId: string,
  durationCalendarIds: string[],
  date: Date,
  filter: CalendarEventFilter = { mode: "ALL" },
): Promise<CalendarDurationResult> {
  const marker = filter.mode === "MARKER" ? filter.marker?.trim() || null : null;
  const normalizedFilter: CalendarEventFilter = {
    mode: filter.mode,
    marker,
  };

  if (durationCalendarIds.length === 0) {
    return {
      durationMs: 0,
      maxEventDurationMs: 0,
      matchedEvents: 0,
      timedEvents: 0,
      filterMode: filter.mode,
      marker,
      blocks: [],
    };
  }

  const { from, to } = dayBounds(date);
  const client = await GoogleCalendarClient.forUser(userId);

  let timedEvents = 0;
  const blocks: CalendarDurationBlock[] = [];

  for (const [calendarIndex, calendarId] of durationCalendarIds.entries()) {
    const events = await client.listEvents(calendarId, from, to);
    const timed = events.filter((event) => !event.allDay);
    const matched = timed.filter((event) =>
      matchesCalendarEventFilter(event, normalizedFilter),
    );

    timedEvents += timed.length;
    for (const event of matched) {
      const durationMs = Math.max(0, event.end.getTime() - event.start.getTime());
      blocks.push({
        key: `${calendarIndex}:${event.id}:${event.start.toISOString()}`,
        eventId: event.id,
        startsAt: new Date(event.start),
        endsAt: new Date(event.end),
        durationMs,
      });
    }
  }

  blocks.sort((left, right) =>
    left.startsAt.getTime() !== right.startsAt.getTime()
      ? left.startsAt.getTime() - right.startsAt.getTime()
      : left.endsAt.getTime() !== right.endsAt.getTime()
        ? left.endsAt.getTime() - right.endsAt.getTime()
        : left.key.localeCompare(right.key),
  );

  const durationMs = blocks.reduce((sum, block) => sum + block.durationMs, 0);
  const maxEventDurationMs = blocks.reduce(
    (max, block) => Math.max(max, block.durationMs),
    0,
  );

  return {
    durationMs,
    maxEventDurationMs,
    matchedEvents: blocks.length,
    timedEvents,
    filterMode: filter.mode,
    marker,
    blocks,
  };
}

/**
 * Backward-compatible numeric helper. Existing callers that do not supply a
 * filter preserve the previous ALL-events behavior.
 */
export async function computeCalendarDurationMs(
  userId: string,
  durationCalendarIds: string[],
  date: Date,
  filter: CalendarEventFilter = { mode: "ALL" },
): Promise<number> {
  return (await computeCalendarDuration(userId, durationCalendarIds, date, filter)).durationMs;
}
