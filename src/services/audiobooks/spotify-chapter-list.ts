/**
 * AUDIOBOOK-02 #489 — read-only catalogue for the manual chapter picker.
 * Provider metadata is untrusted; validate every returned chapter.
 *
 * Spotify audiobook Web API access depends on market. If unavailable,
 * the caller should show an explicit unsupported/unavailable state.
 */
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { getSpotifyAccessToken } from "@/services/spotify/token";

const PAGE_SIZE = 50;
const MAX_CHAPTERS = 200;

type Book = { id?: string | null; name?: string | null; type?: string | null };
type Chapter = {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  duration_ms?: number | null;
  is_playable?: boolean | null;
  restrictions?: { reason?: string | null } | null;
};
type ChaptersPage = {
  items?: Chapter[] | null;
  total?: number | null;
  offset?: number | null;
};
export type AudiobookChapterOption = Readonly<{
  id: string;
  name: string;
  durationMs: number;
  playable: boolean;
}>;
export type AudiobookChapterList = Readonly<{
  audiobookId: string;
  audiobookName: string;
  chapters: AudiobookChapterOption[];
  total: number;
  truncated: boolean;
}>;
export type AudiobookCatalogueRead = (path: string) => Promise<unknown>;

export async function loadAudiobookChapterList(
  audiobookId: string,
  read: AudiobookCatalogueRead,
): Promise<AudiobookChapterList> {
  if (!/^[A-Za-z0-9]{22}$/.test(audiobookId)) {
    throw new Error("AUDIOBOOK_CATALOG_INVALID_BOOK_ID");
  }
  const book = (await read("/audiobooks/" + audiobookId)) as Book | null;
  if (!book || book.id !== audiobookId || book.type !== "audiobook" ||
    typeof book.name !== "string" || !book.name.trim()) {
    throw new Error("AUDIOBOOK_CATALOG_BOOK_NOT_AVAILABLE");
  }
  const chapters: AudiobookChapterOption[] = [];
  let total = 0;
  for (let offset = 0; offset < MAX_CHAPTERS; offset += PAGE_SIZE) {
    const page = (await read(
      "/audiobooks/" + audiobookId + "/chapters?limit=" + PAGE_SIZE + "&offset=" + offset,
    )) as ChaptersPage | null;
    if (!page || !Array.isArray(page.items) ||
      typeof page.total !== "number" || !Number.isSafeInteger(page.total) ||
      page.total < 0 || page.offset !== offset || page.items.length > PAGE_SIZE) {
      throw new Error("AUDIOBOOK_CATALOG_CHAPTERS_INCOMPLETE");
    }
    total = page.total;
    for (const raw of page.items) {
      if (!raw || typeof raw.id !== "string" || !/^[A-Za-z0-9]{22}$/.test(raw.id) ||
        raw.type !== "episode" || typeof raw.name !== "string" || !raw.name.trim() ||
        typeof raw.duration_ms !== "number" || !Number.isSafeInteger(raw.duration_ms) ||
        raw.duration_ms <= 0) {
        throw new Error("AUDIOBOOK_CATALOG_CHAPTER_INVALID");
      }
      chapters.push({
        id: raw.id,
        name: raw.name.trim(),
        durationMs: raw.duration_ms,
        playable: raw.is_playable === true && !Boolean(raw.restrictions?.reason),
      });
    }
    if (chapters.length >= total) break;
    if (page.items.length !== PAGE_SIZE) {
      throw new Error("AUDIOBOOK_CATALOG_CHAPTERS_INCOMPLETE");
    }
  }
  return {
    audiobookId,
    audiobookName: book.name.trim(),
    chapters,
    total,
    truncated: chapters.length < total,
  };
}

export async function readSpotifyAudiobookChapters(
  userId: string,
  audiobookId: string,
): Promise<AudiobookChapterList> {
  const token = await getSpotifyAccessToken(userId);
  return loadAudiobookChapterList(audiobookId, path =>
    spotifyRequestAttempt({
      accessToken: token,
      path,
      method: "GET",
      operation: "spotify-api",
    }),
  );
}
