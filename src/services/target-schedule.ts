export type DailyScheduleSlot = {
  localDate: string;
  localMinutes: number;
  due: boolean;
  scheduleKey: string;
};

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function dailyScheduleSlot(
  targetPlaylistId: string,
  dailyScheduleMinutes: number,
  timeZone: string,
  now: Date,
): DailyScheduleSlot {
  if (!Number.isInteger(dailyScheduleMinutes) || dailyScheduleMinutes < 0 || dailyScheduleMinutes > 1439) {
    throw new Error("dailyScheduleMinutes must be an integer between 0 and 1439");
  }
  if (!isValidTimeZone(timeZone)) throw new Error(`Invalid IANA time zone: ${timeZone}`);

  const parts = localParts(now, timeZone);
  const localMinutes = parts.hour * 60 + parts.minute;
  const localDate = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  return {
    localDate,
    localMinutes,
    due: localMinutes >= dailyScheduleMinutes,
    scheduleKey: `${targetPlaylistId}:${localDate}`,
  };
}

export function formatScheduleTime(minutes: number): string {
  const safe = Math.min(1439, Math.max(0, Math.trunc(minutes)));
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
}

export function parseScheduleTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

export function nextScheduleLabel(
  dailyScheduleMinutes: number,
  timeZone: string,
  now: Date,
  alreadyCompletedToday: boolean,
): string {
  if (!isValidTimeZone(timeZone)) return "fuso inválido";
  const slot = dailyScheduleSlot("preview", dailyScheduleMinutes, timeZone, now);
  const day = alreadyCompletedToday || slot.due ? "amanhã" : "hoje";
  return `${day}, ${formatScheduleTime(dailyScheduleMinutes)} (${timeZone})`;
}

function localParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
