/** #473 Gate B: strict read-only Spotify show search normalization. */
export type DiscoveredShow = {
  id: string;
  name: string;
  publisher: string | null;
  description: string | null;
  languages: string[];
  totalEpisodes: number | null;
  spotifyUrl: string;
};

export function spotifyShowSearchPath(input: { query: string; market?: string; limit?: number }): string {
  const query = input.query.trim().replace(/\s+/g, " ");
  if (!query || query.length > 120) throw new Error("Invalid show query");
  const market = (input.market ?? "BR").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(market)) throw new Error("Invalid market");
  const limit = input.limit ?? 8;
  if (!Number.isFinite(limit)) throw new Error("Invalid limit");
  const params = new URLSearchParams({
    q: query, type: "show", market,
    limit: String(Math.max(1, Math.min(10, Math.floor(limit)))),
  });
  return "/search?" + params.toString();
}

export function normalizeSpotifyShow(input: unknown): DiscoveredShow | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9]{22}$/.test(value.id)) return null;
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  const languages = Array.isArray(value.languages)
    ? value.languages.filter((v): v is string => typeof v === "string").slice(0, 8) : [];
  return {
    id: value.id,
    name: value.name.trim(),
    publisher: typeof value.publisher === "string" ? value.publisher.trim() || null : null,
    description: typeof value.description === "string" ? value.description.trim().slice(0, 500) || null : null,
    languages,
    totalEpisodes: typeof value.total_episodes === "number" && Number.isSafeInteger(value.total_episodes) && value.total_episodes >= 0 ? value.total_episodes : null,
    spotifyUrl: "https://open.spotify.com/show/" + value.id,
  };
}

export function normalizeShowSearchResponse(input: unknown): DiscoveredShow[] {
  if (!input || typeof input !== "object") return [];
  const root = input as { shows?: { items?: unknown } };
  const items = root.shows?.items;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const result: DiscoveredShow[] = [];
  for (const item of items) {
    const show = normalizeSpotifyShow(item);
    if (!show || seen.has(show.id)) continue;
    seen.add(show.id);
    result.push(show);
    if (result.length === 10) break;
  }
  return result;
}
