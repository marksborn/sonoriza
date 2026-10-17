/**
 * AUDIOBOOK-01 Gate 1D — shape-only helpers. No token, DB or Spotify writes.
 * "spotify:episode:" URI prefix is not evidence that a chapter is eligible for
 * POST /playlists/{id}/items: this gate ONLY observes read-only differences.
 */
import { asObject, profileId, safeId, stringField } from "./audiobook-playlist-gate1c";

export const GATE1D = {
  bookId: "5E76EUAq7or1ncd4QNyHjI",
  chapterId: "71PKNrJrxgaYwUY6srGQ3L",
  chapterUri: "spotify:episode:71PKNrJrxgaYwUY6srGQ3L",
  controlEpisodeId: "28WCykrOJqzTpUKSrABWwk",
  controlEpisodeUri: "spotify:episode:28WCykrOJqzTpUKSrABWwk",
  manualPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
  manualPlaylistName: "Sonoriza Teste Audiolivros — AUDIOBOOK-01",
  secondPlaylistId: "1tsFauBmlMXWJLNKTCQFQE",
  secondPlaylistName: "Sonoriza Teste Capitulo 1984 - AUDIOBOOK-01",
} as const;

export function contentShape(raw: unknown, expectedId: string) {
  const obj = asObject(raw);
  const uri = stringField(obj?.uri);
  return {
    exists: obj !== null,
    idMatches: safeId(obj?.id) === expectedId,
    type: stringField(obj?.type),
    uriMatches: uri === `spotify:episode:${expectedId}`,
    uriLooksLikeEpisode: Boolean(uri?.startsWith("spotify:episode:")),
    playable: obj?.is_playable === true ? true : obj?.is_playable === false ? false : null,
    hasAudiobook: asObject(obj?.audiobook) !== null,
    audiobookIdMatches: asObject(obj?.audiobook)?.id === GATE1D.bookId,
    hasShow: asObject(obj?.show) !== null,
    showType: stringField(asObject(obj?.show)?.type),
    restrictionReasonPresent: typeof asObject(obj?.restrictions)?.reason === "string",
  };
}

export function playlistIdentity(raw: unknown, ownerId: string, playlistId: string) {
  const obj = asObject(raw);
  const expectedName = playlistId === GATE1D.secondPlaylistId
    ? GATE1D.secondPlaylistName
    : playlistId === GATE1D.manualPlaylistId ? GATE1D.manualPlaylistName : null;
  const metadata = asObject(obj?.items);
  return {
    exactId: expectedName !== null && obj?.id === playlistId,
    exactOwner: profileId(obj?.owner) === ownerId,
    exactName: expectedName !== null && obj?.name === expectedName,
    publicState: obj?.public === true ? "true" : obj?.public === false ? "false" : "unknown",
    collaborative: obj?.collaborative === true ? true : obj?.collaborative === false ? false : null,
    detailsTotal: typeof metadata?.total === "number" && Number.isInteger(metadata.total)
      ? metadata.total : null,
  };
}

export function playlistItemsShape(raw: unknown, chapterUri: string, controlUri: string) {
  const obj = asObject(raw);
  const rows = Array.isArray(obj?.items) ? obj.items : [];
  const types: Array<string | null> = [];
  let opaque = 0;
  let chaptersByUri = 0;
  let podcastByUri = 0;
  for (const row of rows) {
    const item = asObject(asObject(row)?.item) ?? asObject(asObject(row)?.track);
    types.push(stringField(item?.type));
    if (!item) opaque++;
    if (item?.uri === chapterUri) chaptersByUri++;
    if (item?.uri === controlUri) podcastByUri++;
  }
  return {
    total: typeof obj?.total === "number" && Number.isInteger(obj.total) ? obj.total : null,
    rowsReturned: rows.length,
    opaqueCount: opaque,
    types,
    chapterUriMatches: chaptersByUri,
    controlEpisodeUriMatches: podcastByUri,
    hasNextPage: Boolean(obj?.next),
  };
}

export function gate1dHypothesis(chapterType: string | null, episodeLookupStatus: number | null,
  episodeLookupType: string | null, controlEpisodeType: string | null) {
  if (chapterType === "chapter" && episodeLookupStatus === 404 &&
      controlEpisodeType === "episode") {
    return "CHAPTER_CATALOG_OBJECT_NOT_RESOLVED_AS_ORDINARY_EPISODE";
  }
  if (chapterType === "chapter" && episodeLookupType === "episode" &&
      controlEpisodeType === "episode") {
    return "BOTH_ENDPOINTS_RESOLVE_ID_BUT_PLAYLIST_COMPATIBILITY_UNPROVEN";
  }
  if (chapterType === "chapter" && episodeLookupType === "chapter") {
    return "EPISODES_ENDPOINT_RETURNED_CHAPTER_TYPE_NOT_EQUIVALENT_TO_EPISODE";
  }
  return "INCONCLUSIVE_READ_ONLY_SHAPES";
}
