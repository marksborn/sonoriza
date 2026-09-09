import { prisma } from "@/lib/prisma";

export type EventCompositionPolicyValue =
  | "INHERIT_DESTINATION"
  | "PODCAST_THEN_MUSIC";

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
}>;

export type CalendarEventCompositionPolicyInput = Readonly<{
  eventCompositionPolicy: EventCompositionPolicyValue;
  maxPodcastsPerEvent: number;
  podcastEventSafetyMarginSeconds: number;
  podcastEventDistribution: PodcastEventDistributionValue;
  podcastEveryNEvents?: number | null;
  podcastEventOffset?: number | null;
}>;

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
    input.eventCompositionPolicy !== "PODCAST_THEN_MUSIC"
  ) {
    throw new Error(
      "Event composition policy must be INHERIT_DESTINATION or PODCAST_THEN_MUSIC.",
    );
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
    },
    update: {
      eventCompositionPolicy: resolved.eventCompositionPolicy,
      maxPodcastsPerEvent: resolved.maxPodcastsPerEvent,
      podcastEventSafetyMarginSeconds:
        resolved.podcastEventSafetyMarginSeconds,
      podcastEventDistribution: resolved.podcastEventDistribution,
      podcastEveryNEvents: resolved.podcastEveryNEvents,
      podcastEventOffset: resolved.podcastEventOffset,
    },
  });

  return resolved;
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
