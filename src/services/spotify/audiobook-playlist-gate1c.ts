/** AUDIOBOOK-01 Gate 1C: immutable experiment contract and pure response guards. */
export const GATE1C = {
  audiobookId: "5E76EUAq7or1ncd4QNyHjI",
  chapterId: "71PKNrJrxgaYwUY6srGQ3L",
  chapterUri: "spotify:episode:71PKNrJrxgaYwUY6srGQ3L",
  playlistName: "Sonoriza Teste Audiolivros — AUDIOBOOK-01",
  secondPrivatePlaylistName: "Sonoriza Teste Capitulo 1984 - AUDIOBOOK-01",
  description: "Experimento isolado e privado AUDIOBOOK-01 Gate 1C (#482): capítulo de 1984. Não usar como playlist produtiva.",
  confirm: "AUDIOBOOK-01-CRIAR-E-ADICIONAR",
} as const;

type AnyObject = Record<string, unknown>;
export function asObject(value: unknown): AnyObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as AnyObject : null;
}
export function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
export function safeId(value: unknown): string | null {
  const id = stringField(value);
  return id && /^[A-Za-z0-9]{22}$/.test(id) ? id : null;
}
export function profileId(profile: unknown): string | null {
  return stringField(asObject(profile)?.id);
}
export function chapterEligible(value: unknown): boolean {
  const item = asObject(value);
  const restriction = item?.restrictions;
  return item?.id === GATE1C.chapterId &&
    item.uri === GATE1C.chapterUri &&
    item.is_playable === true &&
    (restriction === null || restriction === undefined ||
      asObject(restriction)?.reason === null ||
      asObject(restriction)?.reason === undefined);
}
export function playlistOwnedPrivate(value: unknown, ownerId: string, expectedName: string = GATE1C.playlistName): boolean {
  const item = asObject(value);
  return safeId(item?.id) !== null &&
    item?.public === false &&
    item?.name === expectedName &&
    item?.collaborative === false &&
    profileId(item?.owner) === ownerId;
}
export function containsChapter(itemsPage: unknown): {
  total: number | null;
  chapterFound: boolean;
  firstItemUri: string | null;
  firstItemType: string | null;
} {
  const page = asObject(itemsPage);
  const items = Array.isArray(page?.items) ? page.items : [];
  const first = asObject(items[0]);
  const item = asObject(first?.item);
  const total = typeof page?.total === "number" && Number.isInteger(page.total) ? page.total : null;
  return {
    total,
    chapterFound: items.some((row) => asObject(asObject(row)?.item)?.uri === GATE1C.chapterUri),
    firstItemUri: stringField(item?.uri),
    firstItemType: stringField(item?.type),
  };
}

/**
 * Fail-closed permission to change only the API-created empty test playlist's
 * visibility, never any existing/manual/production playlist.
 */
export function mayChangeSecondPlaylistToPrivate(
  raw: unknown, expectedId: string, ownerId: string,
): boolean {
  const playlist = asObject(raw);
  const itemCollection = asObject(playlist?.items);
  return safeId(expectedId) !== null &&
    playlist?.id === expectedId &&
    playlist.name === GATE1C.secondPrivatePlaylistName &&
    profileId(playlist.owner) === ownerId &&
    playlist.public === true &&
    playlist.collaborative === false &&
    itemCollection?.total === 0;
}

/**
 * Existing second-playlist chapter insertion preflight.
 * Spotify's Web API public flag is NOT the same as the app's manual
 * "Tornar particular" control. A separate explicit CLI opt-in records
 * the user's manual app confirmation; do not infer privacy from this GET.
 */
export function mayInsertChapterIntoExistingSecondPlaylist(
  raw: unknown, ownerId: string, playlistId: string,
): boolean {
  const p = asObject(raw);
  const items = asObject(p?.items);
  return playlistId === "1tsFauBmlMXWJLNKTCQFQE" &&
    p?.id === playlistId &&
    p.name === GATE1C.secondPrivatePlaylistName &&
    profileId(p.owner) === ownerId &&
    p.collaborative === false &&
    items?.total === 0;
}
