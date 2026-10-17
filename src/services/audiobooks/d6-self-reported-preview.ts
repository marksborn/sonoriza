/**
 * AUDIOBOOK-02 Gate D.6 — offline user-declared duration, intentionally NOT a
 * Spotify catalogue/chapter verification. This does not produce a valid
 * TargetAudiobookOverlay, a Gate D shadow projection, or a Spotify write token.
 * The caller must not persist these values as provider-authenticated evidence.
 */
export const USER_DECLARED_AUDIOBOOK_SOURCE = "USER_DECLARED_UNVERIFIED" as const;
const MAX_TEXT_LENGTH = 120;
const MAX_CHAPTER_DURATION_MS = 24 * 60 * 60 * 1000;

export type UserDeclaredChapterInput = Readonly<{
  targetDurationMs: number;
  bookTitle: string;
  chapterLabel: string;
  chapterDurationMs: number;
  selection: Readonly<{ mode: "FULL_CHAPTER" }> |
    Readonly<{ mode: "MANUAL_REMAINDER"; consumedMs: number }>;
}>;

export type UserDeclaredChapterResult =
  | Readonly<{
      status: "BLOCKED";
      reason:
        | "INVALID_INPUT" | "INVALID_LABELS" | "INVALID_TARGET_DURATION"
        | "INVALID_CHAPTER_DURATION" | "INVALID_SELECTION"
        | "INVALID_MANUAL_PROGRESS" | "CHAPTER_ALREADY_FINISHED"
        | "CHAPTER_EXCEEDS_TARGET";
      durationEvidence: typeof USER_DECLARED_AUDIOBOOK_SOURCE;
      remoteChapterVerified: false;
      remoteBookPresenceVerified: false;
      eligibleForBinding: false;
      eligibleForShadowPlanner: false;
      eligibleForAutomaticReconciliation: false;
      authorizedForAutomaticWrite: false;
      spotifyWrites: false;
      persisted: false;
    }>
  | Readonly<{
      status: "READY_MANUAL_PREVIEW";
      bookTitle: string;
      chapterLabel: string;
      targetDurationMs: number;
      declaredChapterDurationMs: number;
      declaredConsumedMs: number;
      effectivePlanningDurationMs: number;
      remainingPlanningDurationMs: number;
      durationEvidence: typeof USER_DECLARED_AUDIOBOOK_SOURCE;
      remoteChapterVerified: false;
      remoteBookPresenceVerified: false;
      eligibleForBinding: false;
      eligibleForShadowPlanner: false;
      eligibleForAutomaticReconciliation: false;
      authorizedForAutomaticWrite: false;
      spotifyWrites: false;
      persisted: false;
      manualSpotifyControlRequired: true;
    }>;

function isSafePositiveMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isSafeNonNegativeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function blocked(reason: Extract<UserDeclaredChapterResult, { status: "BLOCKED" }>["reason"]):
  UserDeclaredChapterResult {
  return {
    status: "BLOCKED",
    reason,
    durationEvidence: USER_DECLARED_AUDIOBOOK_SOURCE,
    remoteChapterVerified: false,
    remoteBookPresenceVerified: false,
    eligibleForBinding: false,
    eligibleForShadowPlanner: false,
    eligibleForAutomaticReconciliation: false,
    authorizedForAutomaticWrite: false,
    spotifyWrites: false,
    persisted: false,
  };
}

/**
 * Computes a standalone NOT-SAVED plan. Does not call the verified Gate A
 * calculator: that calculator's chapterDurationMs is explicitly Spotify GET
 * evidence. Using it here would erase the provenance distinction.
 */
export function previewUserDeclaredChapterDuration(
  input: UserDeclaredChapterInput,
): UserDeclaredChapterResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return blocked("INVALID_INPUT");
  }
  if (typeof input.bookTitle !== "string" ||
      typeof input.chapterLabel !== "string" ||
      !input.bookTitle.trim() || !input.chapterLabel.trim() ||
      input.bookTitle.trim().length > MAX_TEXT_LENGTH ||
      input.chapterLabel.trim().length > MAX_TEXT_LENGTH ||
      /[\x00-\x1f\x7f]/.test(input.bookTitle + input.chapterLabel)) {
    return blocked("INVALID_LABELS");
  }
  if (!isSafePositiveMs(input.targetDurationMs) ||
      input.targetDurationMs > MAX_CHAPTER_DURATION_MS) {
    return blocked("INVALID_TARGET_DURATION");
  }
  if (!isSafePositiveMs(input.chapterDurationMs) ||
      input.chapterDurationMs > MAX_CHAPTER_DURATION_MS) {
    return blocked("INVALID_CHAPTER_DURATION");
  }
  const selection: unknown = input.selection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return blocked("INVALID_SELECTION");
  }
  const s = selection as Record<string, unknown>;
  let consumedMs = 0;
  if (s.mode === "FULL_CHAPTER" && Object.keys(s).length === 1) {
    consumedMs = 0;
  } else if (s.mode === "MANUAL_REMAINDER" &&
             Object.keys(s).length === 2) {
    if (!isSafeNonNegativeMs(s.consumedMs) ||
        s.consumedMs > input.chapterDurationMs) {
      return blocked("INVALID_MANUAL_PROGRESS");
    }
    if (s.consumedMs === input.chapterDurationMs) {
      return blocked("CHAPTER_ALREADY_FINISHED");
    }
    consumedMs = s.consumedMs;
  } else {
    return blocked("INVALID_SELECTION");
  }
  const effectiveMs = input.chapterDurationMs - consumedMs;
  if (effectiveMs > input.targetDurationMs) {
    return blocked("CHAPTER_EXCEEDS_TARGET");
  }
  return {
    status: "READY_MANUAL_PREVIEW",
    bookTitle: input.bookTitle.trim(),
    chapterLabel: input.chapterLabel.trim(),
    targetDurationMs: input.targetDurationMs,
    declaredChapterDurationMs: input.chapterDurationMs,
    declaredConsumedMs: consumedMs,
    effectivePlanningDurationMs: effectiveMs,
    remainingPlanningDurationMs: input.targetDurationMs - effectiveMs,
    durationEvidence: USER_DECLARED_AUDIOBOOK_SOURCE,
    remoteChapterVerified: false,
    remoteBookPresenceVerified: false,
    eligibleForBinding: false,
    eligibleForShadowPlanner: false,
    eligibleForAutomaticReconciliation: false,
    authorizedForAutomaticWrite: false,
    spotifyWrites: false,
    persisted: false,
    manualSpotifyControlRequired: true,
  };
}

/** Strict decimal-to-ms parser for a human editor: "20.039" means 20,039ms. */
export function parseManualSecondsToMs(raw: string): number | null {
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d{0,5})(?:[.,]\d{1,3})?$/.test(raw)) {
    return null;
  }
  const [whole, fraction = ""] = raw.replace(",", ".").split(".");
  const milliseconds = Number(whole) * 1000 +
    Number(fraction.padEnd(3, "0"));
  return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_CHAPTER_DURATION_MS
    ? milliseconds : null;
}

export function formatManualDuration(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) return "inválido";
  const minutes = Math.floor(ms / 60000);
  return `${minutes}min ${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}s`;
}

/** Produces copyable local notes, never a Spotify URI, binding payload or approval. */
export function formatUserDeclaredChapterNotes(
  input: Extract<UserDeclaredChapterResult, { status: "READY_MANUAL_PREVIEW" }>,
  targetName: string,
): string {
  return [
    "SONORIZA — ANOTAÇÃO MANUAL, NÃO VERIFICADA PELO SPOTIFY",
    `Destino: ${targetName.trim().slice(0, 120)}`,
    `Livro informado: ${input.bookTitle}`,
    `Capítulo informado: ${input.chapterLabel}`,
    `Duração informada: ${formatManualDuration(input.declaredChapterDurationMs)}`,
    `Tempo já consumido informado: ${formatManualDuration(input.declaredConsumedMs)}`,
    `Duração virtual: ${formatManualDuration(input.effectivePlanningDurationMs)}`,
    `Duração alvo: ${formatManualDuration(input.targetDurationMs)}`,
    `Saldo virtual: ${formatManualDuration(input.remainingPlanningDurationMs)}`,
    "Origem: USER_DECLARED_UNVERIFIED; Spotify NÃO confirmou capítulo, livro ou duração.",
    "RASCUNHO NÃO SALVO: não cria vínculo, simulação SHADOW nem agenda.",
    "A reprodução, a troca de capítulo e as alterações da playlist são manuais no Spotify.",
  ].join("\n");
}
