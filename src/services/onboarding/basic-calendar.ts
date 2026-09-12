import {
  CalendarDurationStrategy,
  CalendarEventFilterMode,
  DurationMode,
  EmptyCalendarBehavior,
  TargetCalendarMode,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  GoogleCalendarClient,
  type CalendarSummary,
} from "@/services/google-calendar";
import {
  normalizeTargetCalendarSelectionIds,
} from "@/services/target-calendar-selection";

export type OnboardingCalendarErrorCode =
  | "no-target"
  | "google-not-connected"
  | "google"
  | "calendar-selection";

export class OnboardingCalendarError
  extends Error {
  constructor(
    readonly code: OnboardingCalendarErrorCode,
  ) {
    super(code);
    this.name = "OnboardingCalendarError";
  }
}

export async function listOnboardingCalendarOptions(
  userId: string,
): Promise<CalendarSummary[]> {
  const account =
    await prisma.account.findFirst({
      where: {
        userId,
        provider: "google",
      },
      select: { id: true },
    });

  if (!account) {
    throw new OnboardingCalendarError(
      "google-not-connected",
    );
  }

  let calendars: CalendarSummary[];

  try {
    const client =
      await GoogleCalendarClient.forUser(
        userId,
      );

    calendars =
      await client.listCalendars();
  } catch {
    throw new OnboardingCalendarError(
      "google",
    );
  }

  return calendars.sort((left, right) => {
    if (left.primary && !right.primary) {
      return -1;
    }

    if (!left.primary && right.primary) {
      return 1;
    }

    return left.summary.localeCompare(
      right.summary,
      "pt-BR",
    );
  });
}

export async function configureOnboardingTargetCalendar(
  input: {
    userId: string;
    targetId: string;
    googleCalendarIds: readonly string[];
  },
) {
  const target =
    await prisma.targetPlaylist.findFirst({
      where: {
        id: input.targetId,
        userId: input.userId,
      },
      select: { id: true },
    });

  if (!target) {
    throw new OnboardingCalendarError(
      "no-target",
    );
  }

  const requestedIds =
    normalizeTargetCalendarSelectionIds(
      input.googleCalendarIds,
    );

  if (requestedIds.length === 0) {
    throw new OnboardingCalendarError(
      "calendar-selection",
    );
  }

  const available =
    await listOnboardingCalendarOptions(
      input.userId,
    );

  const availableById = new Map(
    available.map((calendar) => [
      calendar.id,
      calendar,
    ]),
  );

  const selectedCalendars =
    requestedIds.map((calendarId) => {
      const calendar =
        availableById.get(calendarId);

      if (!calendar) {
        throw new OnboardingCalendarError(
          "calendar-selection",
        );
      }

      return calendar;
    });

  return prisma.$transaction(
    async (tx) => {
      const persisted: {
        id: string;
      }[] = [];

      for (
        const calendar of selectedCalendars
      ) {
        const row =
          await tx.calendarSelection.upsert({
            where: {
              userId_googleCalendarId: {
                userId: input.userId,
                googleCalendarId:
                  calendar.id,
              },
            },
            create: {
              userId: input.userId,
              googleCalendarId:
                calendar.id,
              summary: calendar.summary,
              selected: true,

              // Campo legado global. O vínculo
              // específico do destino vive em
              // TargetPlaylistCalendar.
              usedForDuration: false,
            },
            update: {
              summary: calendar.summary,
              selected: true,
            },
            select: { id: true },
          });

        persisted.push(row);
      }

      const updated =
        await tx.targetPlaylist.updateMany({
          where: {
            id: input.targetId,
            userId: input.userId,
          },
          data: {
            durationMode:
              DurationMode.CALENDAR,

            fixedDurationSeconds: null,

            calendarMode:
              TargetCalendarMode.SELECTED,

            // Fail-safe: um dia sem evento não
            // limpa playlist existente.
            emptyCalendarBehavior:
              EmptyCalendarBehavior.KEEP,

            calendarEventFilterMode:
              CalendarEventFilterMode.ALL,

            calendarEventMarker: null,

            calendarDurationStrategy:
              CalendarDurationStrategy.SUMMED,
          },
        });

      if (updated.count !== 1) {
        throw new OnboardingCalendarError(
          "no-target",
        );
      }

      await tx.targetPlaylistCalendar.deleteMany(
        {
          where: {
            targetPlaylistId:
              input.targetId,
          },
        },
      );

      await tx.targetPlaylistCalendar.createMany(
        {
          data: persisted.map(
            (calendar) => ({
              targetPlaylistId:
                input.targetId,

              calendarSelectionId:
                calendar.id,
            }),
          ),
        },
      );

      return {
        targetId: input.targetId,
        calendarCount: persisted.length,
      };
    },
  );
}
