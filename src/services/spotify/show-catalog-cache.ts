const SHOW_CATALOG_CACHE_VERSION = 1;
const SHOW_CATALOG_CACHE_KIND = "PODCAST_SHOW_CATALOG";
const DAY_MS = 86_400_000;

export const SHOW_CATALOG_CACHE_TTL_MS = DAY_MS;

export type ShowCatalogEpisode = {
  id?: string;
  uri: string;
  name: string;
  duration_ms: number;
  type: "episode";
  is_local?: boolean;
  is_playable?: boolean;
  restrictions?: { reason?: string | null } | null;
  show?: {
    id?: string;
    name?: string;
  };
  release_date?: string;
  release_date_precision?: string;
};

export type ShowCatalogCachePayload = {
  kind: typeof SHOW_CATALOG_CACHE_KIND;
  version: typeof SHOW_CATALOG_CACHE_VERSION;
  pageCount: number;
  episodes: ShowCatalogEpisode[];
};

/**
 * Catalog cache intentionally excludes resume_point/playback state. Canonical
 * listening state remains in EpisodeListeningState and is resolved separately
 * when a warm catalog cache is consumed.
 */
export function encodeShowCatalogCache(
  episodes: readonly ShowCatalogEpisode[],
  pageCount: number,
): ShowCatalogCachePayload {
  return {
    kind: SHOW_CATALOG_CACHE_KIND,
    version: SHOW_CATALOG_CACHE_VERSION,
    pageCount: normalizeCount(pageCount),
    episodes: episodes.map((episode) => ({
      ...(normalizedOptionalText(episode.id)
        ? { id: normalizedOptionalText(episode.id)! }
        : {}),
      uri: episode.uri,
      name: episode.name,
      duration_ms: Math.max(0, Math.trunc(episode.duration_ms)),
      type: "episode" as const,
      ...(typeof episode.is_local === "boolean"
        ? { is_local: episode.is_local }
        : {}),
      ...(typeof episode.is_playable === "boolean"
        ? { is_playable: episode.is_playable }
        : {}),
      ...(normalizedOptionalText(episode.restrictions?.reason)
        ? { restrictions: { reason: normalizedOptionalText(episode.restrictions?.reason) } }
        : {}),
      ...(normalizedOptionalText(episode.show?.id) ||
      normalizedOptionalText(episode.show?.name)
        ? {
            show: {
              ...(normalizedOptionalText(episode.show?.id)
                ? { id: normalizedOptionalText(episode.show?.id)! }
                : {}),
              ...(normalizedOptionalText(episode.show?.name)
                ? { name: normalizedOptionalText(episode.show?.name)! }
                : {}),
            },
          }
        : {}),
      ...(normalizedOptionalText(episode.release_date)
        ? { release_date: normalizedOptionalText(episode.release_date)! }
        : {}),
      ...(normalizedOptionalText(episode.release_date_precision)
        ? {
            release_date_precision: normalizedOptionalText(
              episode.release_date_precision,
            )!,
          }
        : {}),
    })),
  };
}

export function decodeShowCatalogCache(
  value: unknown,
): ShowCatalogCachePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.kind !== SHOW_CATALOG_CACHE_KIND ||
    payload.version !== SHOW_CATALOG_CACHE_VERSION ||
    !Number.isInteger(payload.pageCount) ||
    Number(payload.pageCount) < 0 ||
    !Array.isArray(payload.episodes)
  ) {
    return null;
  }

  const episodes: ShowCatalogEpisode[] = [];
  for (const raw of payload.episodes) {
    const episode = decodeEpisode(raw);
    if (!episode) return null;
    episodes.push(episode);
  }

  return {
    kind: SHOW_CATALOG_CACHE_KIND,
    version: SHOW_CATALOG_CACHE_VERSION,
    pageCount: Number(payload.pageCount),
    episodes,
  };
}

export function isShowCatalogCacheFresh(
  cacheUpdatedAt: Date | null | undefined,
  now = new Date(),
): boolean {
  if (!(cacheUpdatedAt instanceof Date)) return false;
  const updatedAtMs = cacheUpdatedAt.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - updatedAtMs;
  return ageMs >= 0 && ageMs < SHOW_CATALOG_CACHE_TTL_MS;
}

function decodeEpisode(value: unknown): ShowCatalogEpisode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const episode = value as Record<string, unknown>;
  if (
    episode.type !== "episode" ||
    typeof episode.uri !== "string" ||
    !episode.uri.trim() ||
    typeof episode.name !== "string" ||
    !episode.name.trim() ||
    typeof episode.duration_ms !== "number" ||
    !Number.isFinite(episode.duration_ms) ||
    episode.duration_ms < 0 ||
    !optionalString(episode.id) ||
    !optionalBoolean(episode.is_local) ||
    !optionalBoolean(episode.is_playable) ||
    !optionalString(episode.release_date) ||
    !optionalString(episode.release_date_precision)
  ) {
    return null;
  }

  const restrictions = decodeRestrictions(episode.restrictions);
  if (restrictions === undefined && episode.restrictions !== undefined) return null;
  const show = decodeShow(episode.show);
  if (show === undefined && episode.show !== undefined) return null;

  return {
    ...(typeof episode.id === "string" && episode.id.trim()
      ? { id: episode.id.trim() }
      : {}),
    uri: episode.uri,
    name: episode.name,
    duration_ms: episode.duration_ms,
    type: "episode",
    ...(typeof episode.is_local === "boolean"
      ? { is_local: episode.is_local }
      : {}),
    ...(typeof episode.is_playable === "boolean"
      ? { is_playable: episode.is_playable }
      : {}),
    ...(restrictions ? { restrictions } : {}),
    ...(show ? { show } : {}),
    ...(typeof episode.release_date === "string" && episode.release_date.trim()
      ? { release_date: episode.release_date.trim() }
      : {}),
    ...(typeof episode.release_date_precision === "string" &&
    episode.release_date_precision.trim()
      ? { release_date_precision: episode.release_date_precision.trim() }
      : {}),
  };
}

function decodeRestrictions(
  value: unknown,
): { reason?: string | null } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const restrictions = value as Record<string, unknown>;
  if (!optionalString(restrictions.reason)) return undefined;
  return typeof restrictions.reason === "string" && restrictions.reason.trim()
    ? { reason: restrictions.reason.trim() }
    : {};
}

function decodeShow(
  value: unknown,
): { id?: string; name?: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const show = value as Record<string, unknown>;
  if (!optionalString(show.id) || !optionalString(show.name)) return undefined;
  const id = typeof show.id === "string" ? show.id.trim() : "";
  const name = typeof show.name === "string" ? show.name.trim() : "";
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function normalizedOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
