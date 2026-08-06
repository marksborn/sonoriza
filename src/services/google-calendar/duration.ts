import { GoogleCalendarClient, type CalendarEvent } from "./client";

export interface DayBounds {
  from: Date;
  to: Date;
}

/** [start of day, start of next day) for the given date. */
export function dayBounds(date: Date): DayBounds {
  const from = new Date(date);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

/** Total milliseconds covered by timed events (all-day events are ignored). */
export function sumTimedDurationMs(events: CalendarEvent[]): number {
  return events
    .filter((e) => !e.allDay)
    .reduce((acc, e) => acc + (e.end.getTime() - e.start.getTime()), 0);
}

/**
 * Sums the duration of "trip" events for a day across the given calendars —
 * this is what drives the Car playlist duration. Returns 0 when there are no
 * trips, which the orchestration layer maps to the target's empty-calendar
 * behaviour (clear / keep / skip).
 */
export async function computeTripDurationMs(
  userId: string,
  tripCalendarIds: string[],
  date: Date,
): Promise<number> {
  if (tripCalendarIds.length === 0) return 0;
  const { from, to } = dayBounds(date);
  const client = await GoogleCalendarClient.forUser(userId);

  let totalMs = 0;
  for (const calendarId of tripCalendarIds) {
    const events = await client.listEvents(calendarId, from, to);
    totalMs += sumTimedDurationMs(events);
  }
  return totalMs;
}
