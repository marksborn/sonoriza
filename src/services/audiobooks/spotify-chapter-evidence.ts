/**
 * Spotify audiobook/chapter ownership proof via the CURRENT single-item
 * read-only endpoints. Never derives identities from opaque playlist items.
 * Spotify can decline access for the account/market: fail closed.
 */
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { getSpotifyAccessToken } from "@/services/spotify/token";

type SpotifyChapterEvidenceResponse = {
  id?: string | null;
  type?: string | null;
  duration_ms?: number | null;
  name?: string | null;
  is_playable?: boolean | null;
  restrictions?: { reason?: string | null } | null;
  audiobook?: { id?: string | null; type?: string | null } | null;
};
type SpotifyAudiobookEvidenceResponse = {
  id?: string | null;
  type?: string | null;
  name?: string | null;
};

export type VerifiedAudiobookChapter = Readonly<{
  spotifyAudiobookId: string;
  selectedChapterId: string;
  chapterDurationMs: number;
  providerDurationMs: null;
  audiobookName: string;
  chapterName: string;
}>;

export type AudiobookEvidenceRead = (
  path: string,
) => Promise<unknown>;

export async function assertSpotifyAudiobookChapterEvidence(
  ids: Readonly<{ spotifyAudiobookId: string; selectedChapterId: string }>,
  read: AudiobookEvidenceRead,
): Promise<VerifiedAudiobookChapter> {
  const [book, chapter] = await Promise.all([
    read(`/audiobooks/${ids.spotifyAudiobookId}`) as Promise<SpotifyAudiobookEvidenceResponse>,
    read(`/chapters/${ids.selectedChapterId}`) as Promise<SpotifyChapterEvidenceResponse>,
  ]);
  if (
    book?.id !== ids.spotifyAudiobookId ||
    book?.type !== "audiobook" ||
    typeof book.name !== "string" ||
    !book.name.trim()
  ) {
    throw new Error("AUDIOBOOK_BIND_BLOCKED_UNVERIFIED_BOOK");
  }
  if (
    chapter?.id !== ids.selectedChapterId ||
    chapter?.type !== "episode" ||
    chapter?.audiobook?.id !== ids.spotifyAudiobookId ||
    chapter.is_playable === false ||
    Boolean(chapter.restrictions?.reason) ||
    typeof chapter.name !== "string" ||
    !chapter.name.trim() ||
    !Number.isInteger(chapter.duration_ms) ||
    typeof chapter.duration_ms !== "number" ||
    chapter.duration_ms <= 0 ||
    chapter.duration_ms > 2147483647
  ) {
    throw new Error("AUDIOBOOK_BIND_BLOCKED_UNVERIFIED_CHAPTER");
  }
  return {
    spotifyAudiobookId: book.id,
    selectedChapterId: chapter.id,
    chapterDurationMs: chapter.duration_ms,
    // The Spotify audiobook endpoint does NOT expose an authoritative
    // aggregate duration_ms. Never invent 15h22 from the full-book item.
    providerDurationMs: null,
    audiobookName: book.name.trim(),
    chapterName: chapter.name.trim(),
  };
}

export async function readSpotifyAudiobookChapterEvidence(
  userId: string,
  spotifyAudiobookId: string,
  selectedChapterId: string,
): Promise<VerifiedAudiobookChapter> {
  const token = await getSpotifyAccessToken(userId);
  return assertSpotifyAudiobookChapterEvidence(
    { spotifyAudiobookId, selectedChapterId },
    path =>
      spotifyRequestAttempt({
        accessToken: token,
        path,
        method: "GET",
        operation: "spotify-api",
      }),
  );
}
