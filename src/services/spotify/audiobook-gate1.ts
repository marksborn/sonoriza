/**
 * AUDIOBOOK-01 Gate 1: tiny, provider-data-only normalizers.
 * No Spotify calls, DB, playback, playlists or personal listening analytics.
 */
export type SpotifyObject = Record<string, unknown>;

function object(input: unknown): SpotifyObject | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as SpotifyObject
    : null;
}
function string(input: unknown): string | null {
  return typeof input === "string" ? input : null;
}
function integer(input: unknown): number | null {
  return typeof input === "number" && Number.isInteger(input) && input >= 0
    ? input : null;
}
function boolean(input: unknown): boolean | null {
  return typeof input === "boolean" ? input : null;
}

export type CatalogIdentity = {
  recognized: boolean;
  apiType: string | null;
  id: string | null;
  name: string | null;
  totalChapters: number | null;
  externalUrl: string | null;
};

export function catalogIdentity(value: unknown, expectedType: "audiobook" | "show"): CatalogIdentity {
  const data = object(value);
  const external = object(data?.external_urls);
  return {
    recognized: data?.type === expectedType,
    apiType: string(data?.type),
    id: string(data?.id),
    name: string(data?.name),
    totalChapters: integer(data?.total_chapters),
    externalUrl: string(external?.spotify),
  };
}

export type ChapterIdentity = {
  id: string | null;
  uri: string | null;
  apiType: string | null;
  chapterNumber: number | null;
  durationMs: number | null;
  isPlayable: boolean | null;
  restriction: string | null;
  hasResumePoint: boolean;
  // Do NOT include the user's resume_position_ms in the probe report.
};

export function chapterIdentity(value: unknown): ChapterIdentity {
  const data = object(value);
  const restriction = object(data?.restrictions);
  return {
    id: string(data?.id),
    uri: string(data?.uri),
    apiType: string(data?.type),
    chapterNumber: integer(data?.chapter_number),
    durationMs: integer(data?.duration_ms),
    isPlayable: boolean(data?.is_playable),
    restriction: string(restriction?.reason),
    hasResumePoint: object(data?.resume_point) !== null,
  };
}

export function firstChapter(value: unknown): {
  pageCount: number;
  total: number | null;
  chapter: ChapterIdentity | null;
} {
  const data = object(value);
  const rawItems = Array.isArray(data?.items) ? data.items : [];
  return {
    pageCount: rawItems.length,
    total: integer(data?.total),
    chapter: rawItems.length ? chapterIdentity(rawItems[0]) : null,
  };
}
