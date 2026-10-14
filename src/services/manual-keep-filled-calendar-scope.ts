import { resolveTargetCalendarScope } from "./target-calendar-selection";

/** CALENDAR-127 parity: manual KEEP_FILLED must use the generator's scope. */
export function resolveManualKeepFilledCalendarIds(input: {
  durationMode: "CALENDAR" | "FIXED";
  calendarMode: "SELECTED" | "ALL_QUERYABLE" | "LEGACY_GLOBAL";
  selectedGoogleCalendarIds: readonly string[];
  invalidLinkedCalendarCount: number;
  queryableCalendarIds: readonly string[];
  legacyDurationCalendarIds: readonly string[];
}): string[] {
  if (input.durationMode === "FIXED") return [];
  if (input.invalidLinkedCalendarCount > 0) {
    throw new Error("O destino contém calendários desmarcados ou de outra conta.");
  }
  if (input.calendarMode === "SELECTED" && input.selectedGoogleCalendarIds.length === 0) {
    throw new Error("Destino com seleção de calendários vazia.");
  }
  const scope = resolveTargetCalendarScope({
    mode: input.calendarMode,
    selectedGoogleCalendarIds: input.selectedGoogleCalendarIds,
    queryableCalendarIds: input.queryableCalendarIds,
    legacyDurationCalendarIds: input.legacyDurationCalendarIds,
  });
  if (scope.mode !== "LEGACY_GLOBAL" && scope.calendarIds.length === 0) {
    throw new Error("Destino sem calendários elegíveis.");
  }
  return scope.calendarIds;
}

/** Manual no-op must be explicit and never serve as a successful plan. */
export function readManualKeepFilledNoop(summary: unknown): string | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const value = (summary as Record<string, unknown>).manualKeepFilledNoop;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.spotifyWrites !== false || record.realRunApprovalEligible !== false) return null;
  if (record.reason === "CALENDAR_EMPTY_KEEP") return "KEEP";
  if (record.reason === "CALENDAR_EMPTY_SKIP") return "SKIP";
  return null;
}
