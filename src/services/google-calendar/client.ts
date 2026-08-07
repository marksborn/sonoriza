import { getGoogleAccessToken } from "./token";

const API = "https://www.googleapis.com/calendar/v3";

export interface CalendarSummary {
  id: string;
  summary: string;
  primary?: boolean;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start: Date;
  end: Date;
  /** Whether this is an all-day event (no time component). */
  allDay: boolean;
}

/**
 * Google Calendar client scoped to a single user (read-only for the MVP).
 */
export class GoogleCalendarClient {
  private constructor(private readonly accessToken: string) {}

  static async forUser(userId: string): Promise<GoogleCalendarClient> {
    return new GoogleCalendarClient(await getGoogleAccessToken(userId));
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(
        `Google Calendar GET ${path} failed (${res.status}): ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Lists the calendars the user can see, for the calendar-selection UI. */
  async listCalendars(): Promise<CalendarSummary[]> {
    const data = await this.request<{
      items: { id: string; summary: string; primary?: boolean }[];
    }>("/users/me/calendarList");
    return data.items.map((c) => ({
      id: c.id,
      summary: c.summary,
      primary: c.primary,
    }));
  }

  /**
   * Returns the timed events of a calendar within [from, to). All-day events
   * are returned too but flagged, so the duration logic can ignore them.
   */
  async listEvents(
    calendarId: string,
    from: Date,
    to: Date,
  ): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    const data = await this.request<{ items: RawEvent[] }>(
      `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    );
    return data.items
      .filter((e) => e.status !== "cancelled")
      .map(toEvent)
      .filter((e): e is CalendarEvent => e !== null);
  }
}

interface RawEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

function toEvent(raw: RawEvent): CalendarEvent | null {
  if (raw.start?.dateTime && raw.end?.dateTime) {
    return {
      id: raw.id,
      summary: raw.summary,
      description: raw.description,
      start: new Date(raw.start.dateTime),
      end: new Date(raw.end.dateTime),
      allDay: false,
    };
  }
  if (raw.start?.date && raw.end?.date) {
    return {
      id: raw.id,
      summary: raw.summary,
      description: raw.description,
      start: new Date(raw.start.date),
      end: new Date(raw.end.date),
      allDay: true,
    };
  }
  return null;
}
