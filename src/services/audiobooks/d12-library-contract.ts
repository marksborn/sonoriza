import { singleReadingEnabled } from "./d9-completed-reading-contract";
import { parseManualSpotifyShowReference } from "./d10-manual-show-reference";
import { previewUserDeclaredChapterDuration } from "./d6-self-reported-preview";

// D.12 is deliberately opt-in. The prior D.7/D.9 mode stays unchanged by
// default; the write guard protects D.12 markers even if this flag turns OFF.
export function audiobookMultiTargetEnabled(env: Record<string, string | undefined>) {
  return singleReadingEnabled(env) &&
    env.AUDIOBOOK02_MULTI_TARGET_MODE === "ACTIVE";
}

export const LIBRARY_START_CONFIRMATION = "CRIAR_LIVRO_MANUAL_NAO_VERIFICADO";
export const LIBRARY_UPDATE_CONFIRMATION = "ATUALIZAR_CAPITULO_MANUAL";
export const LIBRARY_ATTACH_CONFIRMATION = "CONFIRMO_PROTEGER_PLAYLIST_ANTES_DA_INCLUSAO";
export const LIBRARY_COMPLETE_CONFIRMATION = "CONCLUIR_LIVRO_PRESERVAR_TODOS_OS_DESTINOS";

export type LibraryCommand =
  | Readonly<{ action: "START"; bookTitle: string; spotifyShowId: string;
      chapterLabel: string; chapterDurationMs: number; consumedMs: number }>
  | Readonly<{ action: "UPDATE"; expectedRevision: number;
      chapterLabel: string; chapterDurationMs: number; consumedMs: number }>
  | Readonly<{ action: "ATTACH"; expectedRevision: number; targetPlaylistId: string }>
  | Readonly<{ action: "COMPLETE"; expectedRevision: number }>;

const id = /^[A-Za-z0-9_-]{4,80}$/;
function shape(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function revision(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 &&
    v < 2147483647;
}
function chapter(raw: Record<string, unknown>, bookTitle: string) {
  const result = previewUserDeclaredChapterDuration({
    targetDurationMs: 86_400_000,
    bookTitle, chapterLabel: raw.chapterLabel as string,
    chapterDurationMs: raw.chapterDurationMs as number,
    selection: { mode: "MANUAL_REMAINDER", consumedMs: raw.consumedMs as number },
  });
  return result.status === "READY_MANUAL_PREVIEW" ? result : null;
}

export function parseLibraryCommand(raw: unknown):
  | { ok: true; value: LibraryCommand }
  | { ok: false; code: string } {
  const invalid = (code: string) => ({ ok: false as const, code });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("INVALID_BODY");
  const v = raw as Record<string, unknown>;
  if (v.action === "START") {
    if (!shape(v, ["action","bookTitle","spotifyShowUrl",
      "chapterLabel","chapterDurationMs","consumedMs","confirmation"]) ||
      v.confirmation !== LIBRARY_START_CONFIRMATION) return invalid("INVALID_START");
    const show = parseManualSpotifyShowReference(v.spotifyShowUrl);
    const c = chapter(v, v.bookTitle as string);
    if (!show || !c) return invalid("INVALID_MANUAL_BOOK_OR_CHAPTER");
    return { ok: true, value: {
      action: "START", bookTitle: c.bookTitle,
      spotifyShowId: show.spotifyShowId, chapterLabel: c.chapterLabel,
      chapterDurationMs: c.declaredChapterDurationMs,
      consumedMs: c.declaredConsumedMs,
    } };
  }
  if (v.action === "UPDATE") {
    if (!shape(v, ["action","expectedRevision","chapterLabel",
      "chapterDurationMs","consumedMs","confirmation"]) ||
      v.confirmation !== LIBRARY_UPDATE_CONFIRMATION ||
      !revision(v.expectedRevision)) return invalid("INVALID_UPDATE");
    const c = chapter(v, "Edição manual");
    if (!c) return invalid("INVALID_CHAPTER");
    return { ok: true, value: {
      action: "UPDATE", expectedRevision: v.expectedRevision,
      chapterLabel: c.chapterLabel,
      chapterDurationMs: c.declaredChapterDurationMs,
      consumedMs: c.declaredConsumedMs,
    } };
  }
  if (v.action === "ATTACH") {
    if (!shape(v, ["action","expectedRevision","targetPlaylistId","confirmation"]) ||
      v.confirmation !== LIBRARY_ATTACH_CONFIRMATION ||
      !revision(v.expectedRevision) || typeof v.targetPlaylistId !== "string" ||
      !id.test(v.targetPlaylistId)) return invalid("INVALID_ATTACH");
    return { ok: true, value: {
      action: "ATTACH", expectedRevision: v.expectedRevision,
      targetPlaylistId: v.targetPlaylistId,
    } };
  }
  if (v.action === "COMPLETE") {
    if (!shape(v, ["action","expectedRevision","confirmation"]) ||
      v.confirmation !== LIBRARY_COMPLETE_CONFIRMATION ||
      !revision(v.expectedRevision)) return invalid("INVALID_COMPLETION");
    return { ok: true, value: { action: "COMPLETE", expectedRevision: v.expectedRevision } };
  }
  return invalid("UNKNOWN_ACTION");
}

// A multi-target reading is independent of destination duration. The chapter
// budget is per target. Calendar targets need an actual calendar-derived budget
// before any projection; never infer one from a fixed fallback.
export function projectLibraryChapterBudget(input: {
  chapterDurationMs: number; consumedMs: number;
  durationMode: "FIXED" | "CALENDAR";
  fixedDurationSeconds: number | null;
  calendarDurationMs?: number | null;
}) {
  const virtual = input.chapterDurationMs - input.consumedMs;
  if (!Number.isSafeInteger(virtual) || virtual <= 0 ||
      !Number.isSafeInteger(input.chapterDurationMs) ||
      input.chapterDurationMs > 86_400_000 ||
      !Number.isSafeInteger(input.consumedMs) || input.consumedMs < 0) {
    return { status: "ABSTAIN" as const, reason: "INVALID_MANUAL_CHAPTER",
      spotifyWrites: false as const };
  }
  const total = input.durationMode === "FIXED"
    ? input.fixedDurationSeconds === null ? null : input.fixedDurationSeconds * 1000
    : input.calendarDurationMs ?? null;
  if (total === null) {
    return { status: "NEEDS_CALENDAR_DURATION" as const,
      spotifyWrites: false as const, virtualChapterDurationMs: virtual };
  }
  if (!Number.isSafeInteger(total) || total <= 0 || total > Number.MAX_SAFE_INTEGER) {
    return { status: "ABSTAIN" as const, reason: "INVALID_DESTINATION_DURATION",
      spotifyWrites: false as const };
  }
  if (virtual > total) {
    return { status: "ABSTAIN" as const, reason: "CHAPTER_EXCEEDS_CURRENT_BUDGET",
      spotifyWrites: false as const };
  }
  return {
    status: "READY_LOCAL_PREVIEW" as const,
    targetDurationMs: total,
    virtualChapterDurationMs: virtual,
    remainingBudgetMs: total - virtual,
    spotifyWrites: false as const,
    approvalEligible: false as const,
    plannerInfluence: false as const,
    evidenceSource: "USER_DECLARED_UNVERIFIED" as const,
  };
}
