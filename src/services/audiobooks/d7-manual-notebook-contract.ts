import { parseManualSpotifyShowReference } from "./d10-manual-show-reference";
import {
  previewUserDeclaredChapterDuration,
  type UserDeclaredChapterInput,
} from "./d6-self-reported-preview";

/**
 * Gate D.7 schema/validator. The client does NOT send provider identities,
 * target duration or evidenceSource; target budget is loaded from owner's DB.
 */
export const MANUAL_NOTEBOOK_CONFIRMATION = "SALVAR_ANOTACAO_NAO_VERIFICADA" as const;

export type SaveManualNotebookRequest = Readonly<{
  targetPlaylistId: string;
  expectedRevision: number;
  bookTitle: string;
  spotifyShowId?: string | null;
  chapterLabel: string;
  chapterDurationMs: number;
  selection: UserDeclaredChapterInput["selection"];
  confirmation: typeof MANUAL_NOTEBOOK_CONFIRMATION;
}>;

export function manualNotebookEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env.AUDIOBOOK02_BIND_UI_MODE === "PREVIEW" &&
    env.AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE === "PREVIEW" &&
    env.AUDIOBOOK02_MANUAL_NOTEBOOK_MODE === "ACTIVE" &&
    env.AUDIOBOOK02_WRITE_FENCE_MODE === "ACTIVE";
}

export function parseSaveManualNotebookRequest(raw: unknown):
  | Readonly<{ ok: true; value: SaveManualNotebookRequest }>
  | Readonly<{ ok: false; code: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "INVALID_BODY" };
  }
  const obj = raw as Record<string, unknown>;
  const permitted = ["targetPlaylistId", "expectedRevision", "bookTitle",
    "chapterLabel", "chapterDurationMs", "selection", "confirmation"];
  // The show reference is optional for existing clients; when supplied it
  // must be a Spotify /show/ URL, never an opaque audiobook catalogue ID.
  const showSupplied = Object.prototype.hasOwnProperty.call(obj, "spotifyShowUrl");
  if (Object.keys(obj).length !== permitted.length + (showSupplied ? 1 : 0) ||
      Object.keys(obj).some(k => !permitted.includes(k) && k !== "spotifyShowUrl")) {
    return { ok: false, code: "INVALID_BODY" };
  }
  const show = showSupplied
    ? parseManualSpotifyShowReference(obj.spotifyShowUrl) : null;
  if (showSupplied && !show) {
    return { ok: false, code: "INVALID_SPOTIFY_SHOW_REFERENCE" };
  }
  if (typeof obj.targetPlaylistId !== "string" ||
      !/^[A-Za-z0-9_-]{4,80}$/.test(obj.targetPlaylistId)) {
    return { ok: false, code: "INVALID_TARGET_ID" };
  }
  if (typeof obj.expectedRevision !== "number" ||
      !Number.isSafeInteger(obj.expectedRevision) ||
      obj.expectedRevision < 0 || obj.expectedRevision >= 2147483647) {
    return { ok: false, code: "INVALID_REVISION" };
  }
  if (obj.confirmation !== MANUAL_NOTEBOOK_CONFIRMATION) {
    return { ok: false, code: "EXPLICIT_CONFIRMATION_REQUIRED" };
  }
  const selection = obj.selection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return { ok: false, code: "INVALID_SELECTION" };
  }
  const record = selection as Record<string, unknown>;
  if (record.mode === "FULL_CHAPTER") {
    if (Object.keys(record).length !== 1) return { ok: false, code: "INVALID_SELECTION" };
  } else if (record.mode === "MANUAL_REMAINDER") {
    if (Object.keys(record).length !== 2 ||
        typeof record.consumedMs !== "number" ||
        !Number.isSafeInteger(record.consumedMs)) {
      return { ok: false, code: "INVALID_SELECTION" };
    }
  } else {
    return { ok: false, code: "INVALID_SELECTION" };
  }
  // Validate labels/duration against D.6 WITHOUT trusting any user target.
  const preflight = previewUserDeclaredChapterDuration({
    bookTitle: obj.bookTitle as string,
    chapterLabel: obj.chapterLabel as string,
    chapterDurationMs: obj.chapterDurationMs as number,
    targetDurationMs: 86_400_000,
    selection: record as UserDeclaredChapterInput["selection"],
  });
  if (preflight.status !== "READY_MANUAL_PREVIEW") {
    return { ok: false, code: "INVALID_DECLARED_CHAPTER_" + preflight.reason };
  }
  return { ok: true, value: {
    targetPlaylistId: obj.targetPlaylistId,
    expectedRevision: obj.expectedRevision,
    bookTitle: preflight.bookTitle,
    ...(show ? { spotifyShowId: show.spotifyShowId } : {}),
    chapterLabel: preflight.chapterLabel,
    chapterDurationMs: preflight.declaredChapterDurationMs,
    selection: record as UserDeclaredChapterInput["selection"],
    confirmation: MANUAL_NOTEBOOK_CONFIRMATION,
  } };
}
