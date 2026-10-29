import { prisma } from "@/lib/prisma";

export type EventCompositionPolicyValue =
  | "INHERIT_DESTINATION"
  | "PODCAST_THEN_MUSIC"
  | "SEQUENCE_PER_EVENT";

export type CalendarRemainderFillStrategyValue =
  | "MUSIC_ONLY"
  | "PODCAST_ONLY"
  | "MIX_RATIO"
  | "REPEAT_SEQUENCE";

export type CalendarRemainderFallbackValue = "FILL_WITH_MUSIC" | "LEAVE_GAP";

/**
 * CALENDAR-04 (#532). Present on the snapshot only for SEQUENCE_PER_EVENT so
 * legacy snapshots, and therefore existing CONFIG-04 fingerprints, keep their
 * exact serialized shape.
 */
export type CalendarSequencePerEventSettings = Readonly<{
  remainderFillStrategy: CalendarRemainderFillStrategyValue;
  /** Duration share of the remainder for podcasts; null unless MIX_RATIO. */
  remainderPodcastPercent: number | null;
  remainderFallback: CalendarRemainderFallbackValue;
}>;

export type PodcastEventDistributionValue =
  | "EVERY_EVENT"
  | "EVERY_N_EVENTS";

export type CalendarEventCompositionPolicySnapshot = Readonly<{
  targetPlaylistId: string;
  eventCompositionPolicy: EventCompositionPolicyValue;
  maxPodcastsPerEvent: number;
  podcastEventSafetyMarginSeconds: number;
  podcastEventDistribution: PodcastEventDistributionValue;
  podcastEveryNEvents: number;
  podcastEventOffset: number;
  sequencePerEvent?: CalendarSequencePerEventSettings;
}>;

export type CalendarEventCompositionPolicyInput = Readonly<{
  eventCompositionPolicy: EventCompositionPolicyValue;
  maxPodcastsPerEvent: number;
  podcastEventSafetyMarginSeconds: number;
  podcastEventDistribution: PodcastEventDistributionValue;
  podcastEveryNEvents?: number | null;
  podcastEventOffset?: number | null;
  remainderFillStrategy?: CalendarRemainderFillStrategyValue | null;
  remainderPodcastPercent?: number | null;
  remainderFallback?: CalendarRemainderFallbackValue | null;
}>;

export const DEFAULT_CALENDAR_SEQUENCE_PER_EVENT_STORAGE = Object.freeze({
  remainderFillStrategy: "MUSIC_ONLY" as const,
  remainderPodcastPercent: 30,
  remainderFallback: "FILL_WITH_MUSIC" as const,
});

export const DEFAULT_CALENDAR_EVENT_COMPOSITION_POLICY = Object.freeze({
  eventCompositionPolicy: "INHERIT_DESTINATION" as const,
  maxPodcastsPerEvent: 1,
  podcastEventSafetyMarginSeconds: 0,
  podcastEventDistribution: "EVERY_EVENT" as const,
  podcastEveryNEvents: 1,
  podcastEventOffset: 0,
});

/**
 * CALENDAR-03 Gate 1 contract.
 *
 * Gate 1 persists intent only. The planner does not import this module yet.
 * EVERY_EVENT has one canonical representation (N=1, offset=0). For
 * EVERY_N_EVENTS, N must be positive and the offset must address one position
 * inside the deterministic cycle: 0 <= offset < N.
 */
export function normalizeCalendarEventCompositionPolicy(
  targetPlaylistId: string,
  input: CalendarEventCompositionPolicyInput,
): CalendarEventCompositionPolicySnapshot {
  const normalizedTargetId = normalizedRequiredId(
    targetPlaylistId,
    "targetPlaylistId",
  );

  if (
    input.eventCompositionPolicy !== "INHERIT_DESTINATION" &&
    input.eventCompositionPolicy !== "PODCAST_THEN_MUSIC" &&
    input.eventCompositionPolicy !== "SEQUENCE_PER_EVENT"
  ) {
    throw new Error(
      "Event composition policy must be INHERIT_DESTINATION, PODCAST_THEN_MUSIC or SEQUENCE_PER_EVENT.",
    );
  }

  if (input.eventCompositionPolicy === "SEQUENCE_PER_EVENT") {
    // CALENDAR-04 restarts the sequence at every event. It deliberately has no
    // event cadence (N/offset), podcast cap or margin: one canonical shape.
    return Object.freeze({
      targetPlaylistId: normalizedTargetId,
      ...DEFAULT_CALENDAR_EVENT_COMPOSITION_POLICY,
      eventCompositionPolicy: "SEQUENCE_PER_EVENT",
      sequencePerEvent: normalizeSequencePerEventSettings(input),
    });
  }

  assertPositiveInteger(input.maxPodcastsPerEvent, "maxPodcastsPerEvent");
  assertNonNegativeInteger(
    input.podcastEventSafetyMarginSeconds,
    "podcastEventSafetyMarginSeconds",
  );

  if (input.podcastEventDistribution === "EVERY_EVENT") {
    return Object.freeze({
      targetPlaylistId: normalizedTargetId,
      eventCompositionPolicy: input.eventCompositionPolicy,
      maxPodcastsPerEvent: input.maxPodcastsPerEvent,
      podcastEventSafetyMarginSeconds:
        input.podcastEventSafetyMarginSeconds,
      podcastEventDistribution: "EVERY_EVENT",
      podcastEveryNEvents: 1,
      podcastEventOffset: 0,
    });
  }

  if (input.podcastEventDistribution !== "EVERY_N_EVENTS") {
    throw new Error(
      "Podcast event distribution must be EVERY_EVENT or EVERY_N_EVENTS.",
    );
  }

  const everyN = input.podcastEveryNEvents;
  const offset = input.podcastEventOffset;

  assertPositiveInteger(everyN, "podcastEveryNEvents");
  assertNonNegativeInteger(offset, "podcastEventOffset");

  if (Number(offset) >= Number(everyN)) {
    throw new Error(
      "podcastEventOffset must be smaller than podcastEveryNEvents.",
    );
  }

  return Object.freeze({
    targetPlaylistId: normalizedTargetId,
    eventCompositionPolicy: input.eventCompositionPolicy,
    maxPodcastsPerEvent: input.maxPodcastsPerEvent,
    podcastEventSafetyMarginSeconds:
      input.podcastEventSafetyMarginSeconds,
    podcastEventDistribution: "EVERY_N_EVENTS",
    podcastEveryNEvents: Number(everyN),
    podcastEventOffset: Number(offset),
  });
}

export function defaultCalendarEventCompositionPolicy(
  targetPlaylistId: string,
): CalendarEventCompositionPolicySnapshot {
  return Object.freeze({
    targetPlaylistId: normalizedRequiredId(
      targetPlaylistId,
      "targetPlaylistId",
    ),
    ...DEFAULT_CALENDAR_EVENT_COMPOSITION_POLICY,
  });
}

export async function loadCalendarEventCompositionPolicy(
  userId: string,
  targetPlaylistId: string,
): Promise<CalendarEventCompositionPolicySnapshot> {
  const normalizedUserId = normalizedRequiredId(userId, "userId");
  const normalizedTargetId = normalizedRequiredId(
    targetPlaylistId,
    "targetPlaylistId",
  );

  await assertOwnedTarget(normalizedUserId, normalizedTargetId);

  const row = await prisma.calendarEventCompositionPolicy.findUnique({
    where: {
      userId_targetPlaylistId: {
        userId: normalizedUserId,
        targetPlaylistId: normalizedTargetId,
      },
    },
  });

  if (!row) {
    return defaultCalendarEventCompositionPolicy(normalizedTargetId);
  }

  return normalizeCalendarEventCompositionPolicy(normalizedTargetId, {
    eventCompositionPolicy: row.eventCompositionPolicy,
    maxPodcastsPerEvent: row.maxPodcastsPerEvent,
    podcastEventSafetyMarginSeconds:
      row.podcastEventSafetyMarginSeconds,
    podcastEventDistribution: row.podcastEventDistribution,
    podcastEveryNEvents: row.podcastEveryNEvents,
    podcastEventOffset: row.podcastEventOffset,
    remainderFillStrategy: row.remainderFillStrategy,
    remainderPodcastPercent: row.remainderPodcastPercent,
    remainderFallback: row.remainderFallback,
  });
}

export async function saveCalendarEventCompositionPolicy(
  userId: string,
  targetPlaylistId: string,
  input: CalendarEventCompositionPolicyInput,
): Promise<CalendarEventCompositionPolicySnapshot> {
  const normalizedUserId = normalizedRequiredId(userId, "userId");
  const resolved = normalizeCalendarEventCompositionPolicy(
    targetPlaylistId,
    input,
  );

  await assertOwnedTarget(normalizedUserId, resolved.targetPlaylistId);

  // Saving a legacy policy leaves the CALENDAR-04 columns untouched (database
  // defaults on create), so switching back keeps the last remainder choice.
  const sequenceStorage = resolved.sequencePerEvent
    ? {
        remainderFillStrategy: resolved.sequencePerEvent.remainderFillStrategy,
        ...(resolved.sequencePerEvent.remainderPodcastPercent === null
          ? {}
          : {
              remainderPodcastPercent:
                resolved.sequencePerEvent.remainderPodcastPercent,
            }),
        remainderFallback: resolved.sequencePerEvent.remainderFallback,
      }
    : {};

  await prisma.calendarEventCompositionPolicy.upsert({
    where: {
      userId_targetPlaylistId: {
        userId: normalizedUserId,
        targetPlaylistId: resolved.targetPlaylistId,
      },
    },
    create: {
      userId: normalizedUserId,
      targetPlaylistId: resolved.targetPlaylistId,
      eventCompositionPolicy: resolved.eventCompositionPolicy,
      maxPodcastsPerEvent: resolved.maxPodcastsPerEvent,
      podcastEventSafetyMarginSeconds:
        resolved.podcastEventSafetyMarginSeconds,
      podcastEventDistribution: resolved.podcastEventDistribution,
      podcastEveryNEvents: resolved.podcastEveryNEvents,
      podcastEventOffset: resolved.podcastEventOffset,
      ...sequenceStorage,
    },
    update: {
      eventCompositionPolicy: resolved.eventCompositionPolicy,
      maxPodcastsPerEvent: resolved.maxPodcastsPerEvent,
      podcastEventSafetyMarginSeconds:
        resolved.podcastEventSafetyMarginSeconds,
      podcastEventDistribution: resolved.podcastEventDistribution,
      podcastEveryNEvents: resolved.podcastEveryNEvents,
      podcastEventOffset: resolved.podcastEventOffset,
      ...sequenceStorage,
    },
  });

  return resolved;
}

function normalizeSequencePerEventSettings(
  input: CalendarEventCompositionPolicyInput,
): CalendarSequencePerEventSettings {
  const strategy =
    input.remainderFillStrategy ??
    DEFAULT_CALENDAR_SEQUENCE_PER_EVENT_STORAGE.remainderFillStrategy;
  if (
    strategy !== "MUSIC_ONLY" &&
    strategy !== "PODCAST_ONLY" &&
    strategy !== "MIX_RATIO" &&
    strategy !== "REPEAT_SEQUENCE"
  ) {
    throw new Error(
      "remainderFillStrategy must be MUSIC_ONLY, PODCAST_ONLY, MIX_RATIO or REPEAT_SEQUENCE.",
    );
  }

  const fallback =
    input.remainderFallback ??
    DEFAULT_CALENDAR_SEQUENCE_PER_EVENT_STORAGE.remainderFallback;
  if (fallback !== "FILL_WITH_MUSIC" && fallback !== "LEAVE_GAP") {
    throw new Error("remainderFallback must be FILL_WITH_MUSIC or LEAVE_GAP.");
  }

  let remainderPodcastPercent: number | null = null;
  if (strategy === "MIX_RATIO") {
    const percent = input.remainderPodcastPercent;
    if (!Number.isInteger(percent) || Number(percent) < 0 || Number(percent) > 100) {
      throw new Error("remainderPodcastPercent must be an integer from 0 to 100.");
    }
    remainderPodcastPercent = Number(percent);
  }

  return Object.freeze({
    remainderFillStrategy: strategy,
    remainderPodcastPercent,
    // Music-only remainder never needs a music fallback; keep one canonical value.
    remainderFallback: strategy === "MUSIC_ONLY" ? "FILL_WITH_MUSIC" : fallback,
  });
}

async function assertOwnedTarget(userId: string, targetPlaylistId: string) {
  const target = await prisma.targetPlaylist.findFirst({
    where: {
      id: targetPlaylistId,
      userId,
    },
    select: { id: true },
  });

  if (!target) {
    throw new Error(
      "Target playlist does not exist or does not belong to the user.",
    );
  }
}

function normalizedRequiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function assertPositiveInteger(
  value: number | null | undefined,
  label: string,
): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(
  value: number | null | undefined,
  label: string,
): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}
