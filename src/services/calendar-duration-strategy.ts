import type {
  CalendarDurationResult,
} from "@/services/google-calendar";
import type {
  DurationPlanningBlock,
} from "@/services/playlist-planner";

export type CalendarDurationStrategy =
  | "SUMMED"
  | "PER_EVENT";

export function calendarDurationPlanningBlocks(
  strategy: CalendarDurationStrategy,
  calendar: CalendarDurationResult | null,
): DurationPlanningBlock[] | undefined {
  if (
    strategy !== "PER_EVENT" ||
    !calendar
  ) {
    return undefined;
  }

  return calendar.blocks.map(
    (block) => ({
      key: block.key,
      targetDurationMs:
        Math.max(0, block.durationMs),
      eventId: block.eventId,
      startsAt:
        block.startsAt.toISOString(),
      endsAt:
        block.endsAt.toISOString(),
    }),
  );
}
