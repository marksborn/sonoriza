/**
 * AUDIOBOOK-01/1C podcast-episode control — pure fail-closed guards.
 * The experiment target is the existing second private test playlist only.
 * A genuine episode is independently validated through GET /episodes/{id};
 * sharing the spotify:episode URI prefix with audiobook chapters is not proof.
 */
import { GATE1C, asObject, profileId, safeId, stringField } from "./audiobook-playlist-gate1c";

export const PODCAST_CONTROL = {
  playlistId: "1tsFauBmlMXWJLNKTCQFQE",
  playlistName: GATE1C.secondPrivatePlaylistName,
  writeConfirm: "AUDIOBOOK-01-PODCAST-CONTROLE-UM-EPISODIO",
} as const;

export function controlEpisodeId(input: string | null): string | null {
  if (!input) return null;
  const raw = input.trim();
  let id: string | null = null;
  const spotifyUri = /^spotify:episode:([a-zA-Z0-9]{22})$/.exec(raw);
  if (spotifyUri) id = spotifyUri[1] ?? null;
  if (!id && /^[a-zA-Z0-9]{22}$/.test(raw)) id = raw;
  if (!id) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.hostname !== "open.spotify.com" ||
          url.username || url.password || url.port) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      // Spotify may prefix /intl-pt/ before /episode/ID.
      if (parts.length === 2 && parts[0] === "episode") id = parts[1] ?? null;
      if (parts.length === 3 && /^intl-[a-z]{2}$/i.test(parts[0] ?? "") &&
          parts[1] === "episode") id = parts[2] ?? null;
    } catch {
      return null;
    }
  }
  // Explicitly reject the test audiobook chapter even though its URI is
  // spotify:episode:...; the control must be a different genuine podcast.
  return safeId(id) && id !== GATE1C.chapterId ? id : null;
}

export function eligiblePodcastEpisode(raw: unknown, id: string): boolean {
  const e = asObject(raw);
  const show = asObject(e?.show);
  const restriction = asObject(e?.restrictions);
  return safeId(id) !== null && id !== GATE1C.chapterId &&
    e?.id === id &&
    e?.type === "episode" &&
    e?.uri === `spotify:episode:${id}` &&
    e?.is_playable === true &&
    (e?.restrictions === null || e?.restrictions === undefined || restriction?.reason == null) &&
    show?.type === "show" &&
    safeId(show.id) !== null &&
    typeof e?.name === "string" && e.name.trim().length > 0;
}

export function eligibleEmptyControlPlaylist(raw: unknown, ownerId: string): boolean {
  const p = asObject(raw);
  const collection = asObject(p?.items);
  return p?.id === PODCAST_CONTROL.playlistId &&
    p.name === PODCAST_CONTROL.playlistName &&
    profileId(p.owner) === ownerId &&
    p.public === false &&
    p.collaborative === false &&
    collection?.total === 0 &&
    typeof p.snapshot_id === "string" && p.snapshot_id.length > 0;
}

export function summarizeControlItems(raw: unknown, episodeUri: string): {
  total: number | null;
  returned: number;
  matched: boolean;
  opaque: boolean;
  firstType: string | null;
  firstUriMatches: boolean;
} {
  const page = asObject(raw);
  const rows = Array.isArray(page?.items) ? page.items : [];
  const items = rows.map((v) => {
    const row = asObject(v);
    return asObject(row?.item) ?? asObject(row?.track);
  });
  const first = items[0] ?? null;
  return {
    total: typeof page?.total === "number" && Number.isInteger(page.total) ? page.total : null,
    returned: rows.length,
    matched: items.some(i => i?.uri === episodeUri && i?.type === "episode"),
    opaque: items.some(i => i === null || (i.uri === undefined && i.type === undefined)),
    firstType: stringField(first?.type),
    firstUriMatches: first?.uri === episodeUri,
  };
}
