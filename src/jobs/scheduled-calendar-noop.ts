import type { RunTrigger } from "@prisma/client";

/**
 * #442: only skip downstream source reads for a real, single-target scheduled
 * generation that was explicitly excluded by the calendar KEEP/SKIP policy.
 *
 * Not a generic "no targets" optimization: simulations, unscoped/manual runs,
 * and multi-target runs keep their existing validation/observability paths.
 */
export function isScheduledCalendarNoop(input: {
  trigger: RunTrigger;
  simulate: boolean;
  requestedTargetIds: readonly string[] | null;
  resolvedTargetIds: readonly string[];
  activeTargetIds: readonly string[];
  calendarSkippedTargetIds: readonly string[];
}): boolean {
  const {
    trigger,
    simulate,
    requestedTargetIds,
    resolvedTargetIds,
    activeTargetIds,
    calendarSkippedTargetIds,
  } = input;

  return (
    trigger === "SCHEDULED" &&
    !simulate &&
    requestedTargetIds?.length === 1 &&
    resolvedTargetIds.length === 1 &&
    activeTargetIds.length === 0 &&
    calendarSkippedTargetIds.length === 1 &&
    requestedTargetIds[0] === resolvedTargetIds[0] &&
    resolvedTargetIds[0] === calendarSkippedTargetIds[0]
  );
}
