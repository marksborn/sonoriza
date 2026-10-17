/**
 * AUDIOBOOK-02 #489 — Gate B.3: exact, manual, fail-closed bind request.
 *
 * The user can only select a target owned by their authenticated session.
 * Remote playlist identity is loaded from DB, never trusted from input.
 */
import type { AudiobookChapterPlanningSelection } from "./virtual-chapter-duration";

export const AUDIOBOOK_BIND_CONFIRMATION = "CONFIRMAR_VINCULO_AUDIOLIVRO";

export type ManualAudiobookBindRequest = Readonly<{
  targetPlaylistId: string;
  spotifyAudiobookId: string;
  selectedChapterId: string;
  selection: AudiobookChapterPlanningSelection;
  confirmation: typeof AUDIOBOOK_BIND_CONFIRMATION;
}>;

export type BindValidation =
  | Readonly<{ ok: true; value: ManualAudiobookBindRequest }>
  | Readonly<{ ok: false; code: string }>;

function validSpotifyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{22}$/.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseManualAudiobookBindRequest(raw: unknown): BindValidation {
  if (!isRecord(raw)) return { ok: false, code: "INVALID_BODY" };
  const allowedFields = new Set([
    "targetPlaylistId", "spotifyAudiobookId", "selectedChapterId",
    "selection", "confirmation",
  ]);
  if (Object.keys(raw).some(field => !allowedFields.has(field))) {
    return { ok: false, code: "INVALID_BODY" };
  }
  if (typeof raw.targetPlaylistId !== "string" || !/^[A-Za-z0-9_-]{4,80}$/.test(raw.targetPlaylistId)) {
    return { ok: false, code: "INVALID_TARGET_ID" };
  }
  if (!validSpotifyId(raw.spotifyAudiobookId)) {
    return { ok: false, code: "INVALID_AUDIOBOOK_ID" };
  }
  if (!validSpotifyId(raw.selectedChapterId)) {
    return { ok: false, code: "INVALID_CHAPTER_ID" };
  }
  if (raw.confirmation !== AUDIOBOOK_BIND_CONFIRMATION) {
    return { ok: false, code: "EXPLICIT_CONFIRMATION_REQUIRED" };
  }
  if (!isRecord(raw.selection)) {
    return { ok: false, code: "INVALID_SELECTION" };
  }
  let selection: AudiobookChapterPlanningSelection;
  if (raw.selection.mode === "FULL_CHAPTER") {
    if (Object.keys(raw.selection).length !== 1) {
      return { ok: false, code: "INVALID_SELECTION" };
    }
    selection = { mode: "FULL_CHAPTER" };
  } else if (raw.selection.mode === "MANUAL_REMAINDER") {
    const consumedMs = raw.selection.consumedMs;
    if (
      Object.keys(raw.selection).length !== 2 ||
      typeof consumedMs !== "number" ||
      !Number.isSafeInteger(consumedMs) ||
      consumedMs < 0 ||
      consumedMs > 2147483647
    ) {
      return { ok: false, code: "INVALID_MANUAL_PROGRESS" };
    }
    selection = { mode: "MANUAL_REMAINDER", consumedMs };
  } else {
    return { ok: false, code: "INVALID_SELECTION" };
  }

  return {
    ok: true,
    value: {
      targetPlaylistId: raw.targetPlaylistId,
      spotifyAudiobookId: raw.spotifyAudiobookId,
      selectedChapterId: raw.selectedChapterId,
      selection,
      confirmation: AUDIOBOOK_BIND_CONFIRMATION,
    },
  };
}

/** Only explicitly configured, uniformly fenced deployments may create links. */
export function audiobookBindEnabled(env: Record<string, string | undefined>): boolean {
  return env.AUDIOBOOK02_BIND_MODE === "ACTIVE" &&
    env.AUDIOBOOK02_WRITE_FENCE_MODE === "ACTIVE";
}

/** Reject cross-site browser POSTs; do not treat missing Origin as authorization. */
export function manualAudiobookOriginAllowed(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.host === host
    );
  } catch {
    return false;
  }
}
