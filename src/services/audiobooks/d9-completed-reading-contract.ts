import { manualNotebookEnabled } from "./d7-manual-notebook-contract";

export const COMPLETE_READING_CONFIRMATION = "CONCLUIR_LIVRO_PRESERVAR_HISTORICO" as const;
export const SINGLE_READING_MODE = "AUDIOBOOK02_SINGLE_READING_MODE" as const;

export function singleReadingEnabled(env: Record<string, string | undefined>): boolean {
  return manualNotebookEnabled(env) && env[SINGLE_READING_MODE] === "ACTIVE";
}

export type CompleteReadingRequest = Readonly<{
  targetPlaylistId: string;
  expectedRevision: number;
  confirmation: typeof COMPLETE_READING_CONFIRMATION;
}>;

export function parseCompleteReadingRequest(raw: unknown):
  | Readonly<{ ok: true; value: CompleteReadingRequest }>
  | Readonly<{ ok: false; code: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "INVALID_BODY" };
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).length !== 3 ||
      typeof obj.targetPlaylistId !== "string" ||
      !/^[A-Za-z0-9_-]{4,80}$/.test(obj.targetPlaylistId)) {
    return { ok: false, code: "INVALID_TARGET" };
  }
  if (typeof obj.expectedRevision !== "number" ||
      !Number.isSafeInteger(obj.expectedRevision) ||
      obj.expectedRevision < 1 || obj.expectedRevision > 2147483647) {
    return { ok: false, code: "INVALID_REVISION" };
  }
  if (obj.confirmation !== COMPLETE_READING_CONFIRMATION) {
    return { ok: false, code: "CONFIRMATION_REQUIRED" };
  }
  return { ok: true, value: {
    targetPlaylistId: obj.targetPlaylistId,
    expectedRevision: obj.expectedRevision,
    confirmation: COMPLETE_READING_CONFIRMATION,
  } };
}
