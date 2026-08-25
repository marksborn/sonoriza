export type TargetCalendarScopeMode = "EXPLICIT" | "LEGACY_GLOBAL";

export type TargetCalendarScope = {
  mode: TargetCalendarScopeMode;
  calendarIds: string[];
};

/**
 * CALENDAR #127 compatibility seam.
 *
 * Gate 1 persists an optional CalendarSelection relation on TargetPlaylist but
 * deliberately does not change generation yet. Gate 2 will call this seam:
 *
 * - an explicitly bound target reads only its own Google calendar;
 * - a pre-existing target with no binding keeps the exact legacy global set;
 * - no implicit default calendar is invented.
 *
 * Keeping the legacy fallback explicit in the type makes it possible to remove
 * it later, after every existing calendar-driven target has been migrated by
 * the user.
 */
export function resolveTargetCalendarScope(
  explicitGoogleCalendarId: string | null | undefined,
  legacyDurationCalendarIds: readonly string[],
): TargetCalendarScope {
  const explicit = explicitGoogleCalendarId?.trim();
  if (explicit) {
    return {
      mode: "EXPLICIT",
      calendarIds: [explicit],
    };
  }

  return {
    mode: "LEGACY_GLOBAL",
    calendarIds: [...legacyDurationCalendarIds],
  };
}

/**
 * Only a target that was already calendar-driven and unbound before Gate 2 may
 * remain on the legacy global calendar set. This prevents creating new legacy
 * state when a FIXED target is switched to CALENDAR after per-target selection
 * became available.
 */
export function canPreserveLegacyTargetCalendar(input: {
  durationMode: "FIXED" | "CALENDAR";
  calendarSelectionId: string | null | undefined;
} | null): boolean {
  return Boolean(
    input?.durationMode === "CALENDAR" && !input.calendarSelectionId?.trim(),
  );
}

/**
 * New CALENDAR targets must choose a calendar explicitly. Existing targets are
 * allowed to remain unbound during the compatibility window so deployment of
 * Gate 1 cannot silently change their current duration calculation.
 */
export function requiresExplicitTargetCalendar(input: {
  durationMode: "FIXED" | "CALENDAR";
  isNewTarget: boolean;
  calendarSelectionId: string | null | undefined;
}): boolean {
  if (input.durationMode !== "CALENDAR") return false;
  if (!input.isNewTarget) return false;
  return !input.calendarSelectionId?.trim();
}
