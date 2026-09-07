import type { PodcastCadenceUnitValue } from "./podcast-show-cadence-contract";

export type PodcastCadenceListeningStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "COMPLETED";

export type PodcastCadenceEvidence = {
  spotifyEpisodeId: string;
  spotifyShowId: string | null;
  status: PodcastCadenceListeningStatus;
  firstProgressObservedAt: Date | null;
};

export type PodcastCadenceWindow = {
  unit: PodcastCadenceUnitValue;
  timeZone: string;
  start: Date;
  endExclusive: Date;
  localStartDate: string;
  localEndDateExclusive: string;
};

export type PodcastCadenceShadowEvaluation = {
  showId: string;
  maxEpisodes: number;
  consumedEpisodeIds: string[];
  consumedCount: number;
  limitReached: boolean;
  newEpisodeAllowedByCadence: boolean;
  inProgressContinuationEpisodeIds: string[];
  legacyConsumptionWithoutTimestampEpisodeIds: string[];
  window: PodcastCadenceWindow;
};

type CivilDate = {
  year: number;
  month: number;
  day: number;
};

type ZonedDateTimeParts = CivilDate & {
  hour: number;
  minute: number;
  second: number;
};

type RequiredDateTimePart =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second";

export function resolvePodcastCadenceWindow(input: {
  asOf: Date;
  timeZone: string;
  unit: PodcastCadenceUnitValue;
}): PodcastCadenceWindow {
  assertValidDate(input.asOf, "asOf");
  assertValidTimeZone(input.timeZone);

  const localDate = civilDateAt(input.asOf, input.timeZone);
  let startDate: CivilDate;
  let endDate: CivilDate;

  switch (input.unit) {
    case "DAY":
      startDate = localDate;
      endDate = addCivilDays(localDate, 1);
      break;
    case "WEEK": {
      const weekday = new Date(
        Date.UTC(localDate.year, localDate.month - 1, localDate.day),
      ).getUTCDay();
      const daysSinceMonday = (weekday + 6) % 7;
      startDate = addCivilDays(localDate, -daysSinceMonday);
      endDate = addCivilDays(startDate, 7);
      break;
    }
    case "MONTH":
      startDate = { year: localDate.year, month: localDate.month, day: 1 };
      endDate = addCivilMonths(startDate, 1);
      break;
  }

  return {
    unit: input.unit,
    timeZone: input.timeZone,
    start: zonedMidnightToUtc(startDate, input.timeZone),
    endExclusive: zonedMidnightToUtc(endDate, input.timeZone),
    localStartDate: civilDateLabel(startDate),
    localEndDateExclusive: civilDateLabel(endDate),
  };
}

export function evaluatePodcastShowCadenceShadow(input: {
  evidence: readonly PodcastCadenceEvidence[];
  showId: string;
  maxEpisodes: number;
  unit: PodcastCadenceUnitValue;
  timeZone: string;
  asOf: Date;
}): PodcastCadenceShadowEvaluation {
  const showId = input.showId.trim();
  if (!showId) throw new Error("showId is required");
  if (!Number.isInteger(input.maxEpisodes) || input.maxEpisodes < 1) {
    throw new Error("maxEpisodes must be a positive integer");
  }

  const window = resolvePodcastCadenceWindow({
    asOf: input.asOf,
    timeZone: input.timeZone,
    unit: input.unit,
  });

  const consumedEpisodeIds = new Set<string>();
  const inProgressContinuationEpisodeIds = new Set<string>();
  const legacyConsumptionWithoutTimestampEpisodeIds = new Set<string>();

  for (const entry of input.evidence) {
    if (entry.spotifyShowId !== showId) continue;

    if (entry.status === "IN_PROGRESS") {
      inProgressContinuationEpisodeIds.add(entry.spotifyEpisodeId);
    }

    if (
      entry.status !== "NOT_STARTED" &&
      entry.firstProgressObservedAt === null
    ) {
      legacyConsumptionWithoutTimestampEpisodeIds.add(entry.spotifyEpisodeId);
    }

    const observedAt = entry.firstProgressObservedAt;
    if (!observedAt) continue;
    assertValidDate(observedAt, "firstProgressObservedAt");

    if (
      observedAt.getTime() >= window.start.getTime() &&
      observedAt.getTime() < window.endExclusive.getTime()
    ) {
      consumedEpisodeIds.add(entry.spotifyEpisodeId);
    }
  }

  const consumed = [...consumedEpisodeIds].sort();
  const consumedCount = consumed.length;
  const limitReached = consumedCount >= input.maxEpisodes;

  return {
    showId,
    maxEpisodes: input.maxEpisodes,
    consumedEpisodeIds: consumed,
    consumedCount,
    limitReached,
    newEpisodeAllowedByCadence: !limitReached,
    inProgressContinuationEpisodeIds: [
      ...inProgressContinuationEpisodeIds,
    ].sort(),
    legacyConsumptionWithoutTimestampEpisodeIds: [
      ...legacyConsumptionWithoutTimestampEpisodeIds,
    ].sort(),
    window,
  };
}

function civilDateAt(value: Date, timeZone: string): CivilDate {
  const parts = zonedParts(value, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function zonedParts(value: Date, timeZone: string): ZonedDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  const numeric = (key: RequiredDateTimePart): number => {
    const parsed = Number(values[key]);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Unable to resolve ${key} for time zone ${timeZone}`);
    }
    return parsed;
  };

  return {
    year: numeric("year"),
    month: numeric("month"),
    day: numeric("day"),
    hour: numeric("hour"),
    minute: numeric("minute"),
    second: numeric("second"),
  };
}

function zonedMidnightToUtc(date: CivilDate, timeZone: string): Date {
  const desiredWallClock = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);
  let candidate = desiredWallClock;

  // Intl exposes the wall-clock representation but not the offset directly.
  // Iterating the difference converges to the UTC instant that renders as local
  // midnight, including DST changes without assuming a fixed offset.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const actualWallClock = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = desiredWallClock - actualWallClock;
    candidate += adjustment;
    if (adjustment === 0) break;
  }

  const resolved = new Date(candidate);
  const confirmation = zonedParts(resolved, timeZone);
  if (
    confirmation.year !== date.year ||
    confirmation.month !== date.month ||
    confirmation.day !== date.day ||
    confirmation.hour !== 0 ||
    confirmation.minute !== 0 ||
    confirmation.second !== 0
  ) {
    throw new Error(
      `Unable to resolve civil midnight ${civilDateLabel(date)} in ${timeZone}`,
    );
  }

  return resolved;
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function addCivilMonths(date: CivilDate, months: number): CivilDate {
  const value = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: 1,
  };
}

function civilDateLabel(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(
    2,
    "0",
  )}-${String(date.day).padStart(2, "0")}`;
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
}

function assertValidDate(value: Date, label: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
}
