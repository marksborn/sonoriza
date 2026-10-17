/**
 * AUDIOBOOK-02 D.9.1 — read-only single-reading presentation.
 *
 * D.7 has one notebook PER TARGET, not one active book PER USER. Until an
 * explicit archive/complete workflow exists, do not silently choose between
 * multiple notebooks or infer that all revisions belong to one book.
 *
 * Never returns provider-verified evidence, approval, or Spotify write intent.
 */
export type ManualReadingCandidate = Readonly<{
  userId: string;
  targetPlaylistId: string;
  targetName: string;
  bookTitle: string;
  chapterLabel: string;
  chapterDurationMs: number;
  consumedMs: number;
  evidenceSource: string;
}>;

export type SingleReadingPreview =
  | Readonly<{ status: "NONE"; spotifyWrites: false; verifiedBySpotify: false }>
  | Readonly<{ status: "REVIEW_REQUIRED"; reason:
      "MULTIPLE_NOTEBOOKS" | "INVALID_OWNERSHIP_OR_EVIDENCE" | "INVALID_DURATION";
      spotifyWrites: false; verifiedBySpotify: false }>
  | Readonly<{
      status: "SINGLE_NOTEBOOK";
      targetPlaylistId: string;
      targetName: string;
      bookTitle: string;
      chapterLabel: string;
      chapterRemainingMs: number;
      spotifyWrites: false;
      verifiedBySpotify: false;
      archivalSupported: false;
    }>;

const none = (): SingleReadingPreview =>
  ({ status: "NONE", spotifyWrites: false, verifiedBySpotify: false });
const review = (reason: Extract<SingleReadingPreview,
  { status: "REVIEW_REQUIRED" }>["reason"]): SingleReadingPreview =>
  ({ status: "REVIEW_REQUIRED", reason,
    spotifyWrites: false, verifiedBySpotify: false });

export function projectSingleReadingPreview(
  ownerId: string,
  notebooks: readonly ManualReadingCandidate[],
): SingleReadingPreview {
  if (!ownerId || !Array.isArray(notebooks)) {
    return review("INVALID_OWNERSHIP_OR_EVIDENCE");
  }
  // Never select the first entry if old data contains multiple notebooks.
  if (notebooks.length > 1) return review("MULTIPLE_NOTEBOOKS");
  if (notebooks.length === 0) return none();

  const note = notebooks[0];
  if (!note || note.userId !== ownerId ||
      note.evidenceSource !== "USER_DECLARED_UNVERIFIED" ||
      !note.targetPlaylistId.trim() || !note.targetName.trim() ||
      !note.bookTitle.trim() || !note.chapterLabel.trim()) {
    return review("INVALID_OWNERSHIP_OR_EVIDENCE");
  }
  if (!Number.isSafeInteger(note.chapterDurationMs) ||
      !Number.isSafeInteger(note.consumedMs) ||
      note.chapterDurationMs <= 0 || note.consumedMs < 0 ||
      note.consumedMs >= note.chapterDurationMs) {
    return review("INVALID_DURATION");
  }
  return {
    status: "SINGLE_NOTEBOOK",
    targetPlaylistId: note.targetPlaylistId,
    targetName: note.targetName,
    bookTitle: note.bookTitle,
    chapterLabel: note.chapterLabel,
    chapterRemainingMs: note.chapterDurationMs - note.consumedMs,
    spotifyWrites: false,
    verifiedBySpotify: false,
    archivalSupported: false,
  };
}
