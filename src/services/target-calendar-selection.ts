export type TargetCalendarScopeMode =
  | "SELECTED"
  | "ALL_QUERYABLE"
  | "LEGACY_GLOBAL";

export type TargetCalendarScope = {
  mode: TargetCalendarScopeMode;
  calendarIds: string[];
};

export function normalizeTargetCalendarSelectionIds(
  values: readonly string[],
): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/**
 * CALENDAR #127 Gate 3 scope resolver.
 *
 * SELECTED uses exactly the calendars linked to this destination.
 * ALL_QUERYABLE dynamically follows every CalendarSelection marked selected.
 * LEGACY_GLOBAL exists only for old calendar-driven targets not migrated yet.
 *
 * The resolver deliberately does not invent a fallback when SELECTED or
 * ALL_QUERYABLE resolve to an empty set; callers must fail closed instead.
 */
export function resolveTargetCalendarScope(input: {
  mode: TargetCalendarScopeMode;
  selectedGoogleCalendarIds: readonly string[];
  queryableCalendarIds: readonly string[];
  legacyDurationCalendarIds: readonly string[];
}): TargetCalendarScope {
  const calendarIds =
    input.mode === "SELECTED"
      ? normalizeTargetCalendarSelectionIds(input.selectedGoogleCalendarIds)
      : input.mode === "ALL_QUERYABLE"
        ? normalizeTargetCalendarSelectionIds(input.queryableCalendarIds)
        : normalizeTargetCalendarSelectionIds(input.legacyDurationCalendarIds);

  return { mode: input.mode, calendarIds };
}

export function targetCalendarScopesEqual(
  left: TargetCalendarScope,
  right: TargetCalendarScope,
): boolean {
  return (
    left.mode === right.mode &&
    left.calendarIds.length === right.calendarIds.length &&
    left.calendarIds.every((id, index) => id === right.calendarIds[index])
  );
}

/**
 * A target may remain LEGACY_GLOBAL only if it was already CALENDAR + legacy
 * before this save. FIXED targets and already-migrated targets cannot create a
 * new legacy fallback.
 */
export function canPreserveLegacyTargetCalendar(input: {
  durationMode: "FIXED" | "CALENDAR";
  calendarMode: TargetCalendarScopeMode;
} | null): boolean {
  return Boolean(
    input?.durationMode === "CALENDAR" && input.calendarMode === "LEGACY_GLOBAL",
  );
}
