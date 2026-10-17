/**
 * AUDIOBOOK-02 Gate C: explicit local chapter transition.
 * Neither the body nor the client may supply audiobook ID, playlist ID,
 * chapter duration, or a surrogate for the current overlay revision.
 */
import type { AudiobookChapterPlanningSelection } from "./virtual-chapter-duration";

export const AUDIOBOOK_CHAPTER_CHANGE_CONFIRMATION = "CONFIRMAR_TROCA_MANUAL_CAPITULO";

export type ManualChapterChangeInput = Readonly<{
  targetPlaylistId: string;
  expectedRevision: number;
  selectedChapterId: string;
  selection: AudiobookChapterPlanningSelection;
}>;

export type ConfirmedManualChapterChange = ManualChapterChangeInput & Readonly<{
  confirmation: typeof AUDIOBOOK_CHAPTER_CHANGE_CONFIRMATION;
}>;

export type ChapterChangeParseResult =
  | Readonly<{ ok: true; value: ManualChapterChangeInput }>
  | Readonly<{ ok: false; code: string }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse both preview and confirmation, rejecting all unexpected data. */
export function parseManualChapterChangeRequest(
  raw: unknown,
  requireConfirmation: boolean,
): ChapterChangeParseResult {
  if (!isObject(raw)) return { ok: false, code: "INVALID_BODY" };
  const allowed = requireConfirmation
    ? ["targetPlaylistId", "expectedRevision", "selectedChapterId", "selection", "confirmation"]
    : ["targetPlaylistId", "expectedRevision", "selectedChapterId", "selection"];
  if (Object.keys(raw).some(key => !allowed.includes(key))) {
    return { ok: false, code: "INVALID_BODY" };
  }
  if (requireConfirmation && raw.confirmation !== AUDIOBOOK_CHAPTER_CHANGE_CONFIRMATION) {
    return { ok: false, code: "CHAPTER_CHANGE_CONFIRMATION_REQUIRED" };
  }
  if (typeof raw.targetPlaylistId !== "string" ||
      !/^[A-Za-z0-9_-]{4,80}$/.test(raw.targetPlaylistId)) {
    return { ok: false, code: "INVALID_TARGET_ID" };
  }
  if (typeof raw.expectedRevision !== "number" ||
      !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0 ||
      raw.expectedRevision > 2147483647) {
    return { ok: false, code: "INVALID_REVISION" };
  }
  if (typeof raw.selectedChapterId !== "string" ||
      !/^[A-Za-z0-9]{22}$/.test(raw.selectedChapterId)) {
    return { ok: false, code: "INVALID_CHAPTER_ID" };
  }
  if (!isObject(raw.selection)) return { ok: false, code: "INVALID_SELECTION" };
  let selection: AudiobookChapterPlanningSelection;
  if (raw.selection.mode === "FULL_CHAPTER" && Object.keys(raw.selection).length === 1) {
    selection = { mode: "FULL_CHAPTER" };
  } else if (raw.selection.mode === "MANUAL_REMAINDER" &&
      Object.keys(raw.selection).length === 2 &&
      typeof raw.selection.consumedMs === "number" &&
      Number.isSafeInteger(raw.selection.consumedMs) &&
      raw.selection.consumedMs >= 0 && raw.selection.consumedMs <= 2147483647) {
    selection = { mode: "MANUAL_REMAINDER", consumedMs: raw.selection.consumedMs };
  } else {
    return { ok: false, code: "INVALID_SELECTION" };
  }
  return {
    ok: true,
    value: {
      targetPlaylistId: raw.targetPlaylistId,
      expectedRevision: raw.expectedRevision,
      selectedChapterId: raw.selectedChapterId,
      selection,
    },
  };
}

/** A chapter update is never enabled by the UI preview flag alone. */
export function audiobookChapterUpdateEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env.AUDIOBOOK02_CHAPTER_UPDATE_MODE === "ACTIVE" &&
    env.AUDIOBOOK02_WRITE_FENCE_MODE === "ACTIVE" &&
    env.AUDIOBOOK02_BIND_MODE === "ACTIVE"
  );
}
