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

export interface TripDurationResult {
  durationMs: number;
  matchedEvents: number;
  timedEvents: number;
  filterMode: CalendarEventFilterMode;
  marker: string | null;
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

/**
 * Resolves the calendar-driven duration for a day across the selected trip
 * calendars, while also returning audit metadata for CONFIG-04.
 *
 * MARKER mode is intentionally literal: the event itself already represents
 * the travel block (including outbound/return when modeled that way in Google
 * Calendar). Sonoriza only filters and sums its duration.
 */
export async function computeTripDuration(
  userId: string,
  tripCalendarIds: string[],
  date: Date,
  filter: CalendarEventFilter = { mode: "ALL" },
): Promise<TripDurationResult> {
  const marker = filter.mode === "MARKER" ? filter.marker?.trim() || null : null;
  const normalizedFilter: CalendarEventFilter = {
    mode: filter.mode,
    marker,
  };

  if (tripCalendarIds.length === 0) {
    return {
      durationMs: 0,
      matchedEvents: 0,
      timedEvents: 0,
      filterMode: filter.mode,
      marker,
    };
  }

  const { from, to } = dayBounds(date);
  const client = await GoogleCalendarClient.forUser(userId);

  let durationMs = 0;
  let matchedEvents = 0;
  let timedEvents = 0;

  for (const calendarId of tripCalendarIds) {
    const events = await client.listEvents(calendarId, from, to);
    const timed = events.filter((event) => !event.allDay);
    const matched = timed.filter((event) =>
      matchesCalendarEventFilter(event, normalizedFilter),
    );

    timedEvents += timed.length;
    matchedEvents += matched.length;
    durationMs += sumTimedDurationMs(matched);
  }

  return {
    durationMs,
    matchedEvents,
    timedEvents,
    filterMode: filter.mode,
    marker,
  };
}

/**
 * Backward-compatible numeric helper. Existing callers that do not supply a
 * filter preserve the previous ALL-events behavior.
 */
export async function computeTripDurationMs(
  userId: string,
  tripCalendarIds: string[],
  date: Date,
  filter: CalendarEventFilter = { mode: "ALL" },
): Promise<number> {
  return (await computeTripDuration(userId, tripCalendarIds, date, filter)).durationMs;
}
