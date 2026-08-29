import type { ListeningEventSource, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const LISTENING_HISTORY_PAGE_SIZE = 50;

export const LISTENING_HISTORY_SOURCES = [
  "SPOTIFY_RECENTLY_PLAYED",
  "SPOTIFY_EXTENDED_HISTORY",
  "LASTFM_SCROBBLE",
  "IMPORT",
] as const satisfies readonly ListeningEventSource[];

export type ListeningHistoryPeriod =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "year"
  | "all"
  | "custom";

export type ListeningHistoryFilters = {
  period: ListeningHistoryPeriod;
  from: Date | null;
  toExclusive: Date | null;
  query: string;
  source: ListeningEventSource | null;
  page: number;
  fromInput: string;
  toInput: string;
};

export type ListeningHistoryRow = {
  id: string;
  playedAt: Date;
  trackName: string;
  artistName: string;
  albumName: string | null;
  spotifyTrackId: string | null;
  trackMbid: string | null;
  isrc: string | null;
  source: ListeningEventSource;
  contextType: string | null;
};

export type ListeningHistoryPage = {
  items: ListeningHistoryRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

type RawSearchParams = Record<string, string | string[] | undefined>;

export function resolveListeningHistoryFilters(
  params: RawSearchParams,
  now = new Date(),
): ListeningHistoryFilters {
  const requestedPeriod = single(params.period);
  const period = isListeningHistoryPeriod(requestedPeriod)
    ? requestedPeriod
    : "7d";
  const query = single(params.q).trim().slice(0, 120);
  const sourceValue = single(params.source);
  const source = isListeningHistorySource(sourceValue) ? sourceValue : null;
  const page = clampPage(Number.parseInt(single(params.page), 10));
  const fromInput = normalizedDateInput(single(params.from));
  const toInput = normalizedDateInput(single(params.to));

  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);

  let from: Date | null = null;
  let toExclusive: Date | null = null;

  switch (period) {
    case "today":
      from = today;
      toExclusive = tomorrow;
      break;
    case "yesterday":
      from = addDays(today, -1);
      toExclusive = today;
      break;
    case "7d":
      from = addDays(today, -6);
      toExclusive = tomorrow;
      break;
    case "30d":
      from = addDays(today, -29);
      toExclusive = tomorrow;
      break;
    case "year":
      from = new Date(today.getFullYear(), 0, 1);
      toExclusive = tomorrow;
      break;
    case "custom": {
      const parsedFrom = parseLocalDateInput(fromInput);
      const parsedTo = parseLocalDateInput(toInput);
      from = parsedFrom;
      toExclusive = parsedTo ? addDays(parsedTo, 1) : null;
      if (from && toExclusive && from >= toExclusive) {
        toExclusive = addDays(from, 1);
      }
      break;
    }
    case "all":
      break;
  }

  return {
    period,
    from,
    toExclusive,
    query,
    source,
    page,
    fromInput,
    toInput,
  };
}

export function buildListeningHistoryWhere(
  userId: string,
  filters: Pick<ListeningHistoryFilters, "from" | "toExclusive" | "query" | "source">,
): Prisma.TrackListeningEventWhereInput {
  const playedAt =
    filters.from || filters.toExclusive
      ? {
          ...(filters.from ? { gte: filters.from } : {}),
          ...(filters.toExclusive ? { lt: filters.toExclusive } : {}),
        }
      : undefined;

  const search = filters.query
    ? {
        OR: [
          { trackName: { contains: filters.query, mode: "insensitive" as const } },
          { artistName: { contains: filters.query, mode: "insensitive" as const } },
          { albumName: { contains: filters.query, mode: "insensitive" as const } },
        ],
      }
    : {};

  return {
    userId,
    ...(playedAt ? { playedAt } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...search,
  };
}

export async function listListeningHistory(
  userId: string,
  filters: ListeningHistoryFilters,
): Promise<ListeningHistoryPage> {
  const where = buildListeningHistoryWhere(userId, filters);
  const pageSize = LISTENING_HISTORY_PAGE_SIZE;
  const skip = (filters.page - 1) * pageSize;

  const [items, totalCount] = await Promise.all([
    prisma.trackListeningEvent.findMany({
      where,
      orderBy: [{ playedAt: "desc" }, { id: "desc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        playedAt: true,
        trackName: true,
        artistName: true,
        albumName: true,
        spotifyTrackId: true,
        trackMbid: true,
        isrc: true,
        source: true,
        contextType: true,
      },
    }),
    prisma.trackListeningEvent.count({ where }),
  ]);

  return {
    items,
    page: filters.page,
    pageSize,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  };
}

export function listeningHistorySourceLabel(source: ListeningEventSource): string {
  switch (source) {
    case "SPOTIFY_RECENTLY_PLAYED":
      return "Spotify recente";
    case "SPOTIFY_EXTENDED_HISTORY":
      return "Spotify histórico";
    case "LASTFM_SCROBBLE":
      return "Last.fm";
    case "IMPORT":
      return "Importação";
  }
}

export function historyFilterQueryString(
  filters: ListeningHistoryFilters,
  patch: Partial<{
    period: ListeningHistoryPeriod;
    query: string;
    source: ListeningEventSource | null;
    page: number;
    fromInput: string;
    toInput: string;
  }> = {},
): string {
  const period = patch.period ?? filters.period;
  const query = patch.query ?? filters.query;
  const source = patch.source === undefined ? filters.source : patch.source;
  const page = patch.page ?? filters.page;
  const fromInput = patch.fromInput ?? filters.fromInput;
  const toInput = patch.toInput ?? filters.toInput;
  const params = new URLSearchParams();

  params.set("period", period);
  if (query) params.set("q", query);
  if (source) params.set("source", source);
  if (period === "custom") {
    if (fromInput) params.set("from", fromInput);
    if (toInput) params.set("to", toInput);
  }
  if (page > 1) params.set("page", String(page));

  return params.toString();
}

function isListeningHistoryPeriod(value: string): value is ListeningHistoryPeriod {
  return ["today", "yesterday", "7d", "30d", "year", "all", "custom"].includes(
    value,
  );
}

function isListeningHistorySource(value: string): value is ListeningEventSource {
  return (LISTENING_HISTORY_SOURCES as readonly string[]).includes(value);
}

function single(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function clampPage(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.trunc(value), 500);
}

function normalizedDateInput(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function parseLocalDateInput(value: string): Date | null {
  if (!value) return null;
  const parts = value.split("-");
  if (parts.length !== 3) return null;

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (![year, month, day].every(Number.isInteger)) return null;

  const result = new Date(year, month - 1, day);
  if (
    result.getFullYear() !== year ||
    result.getMonth() !== month - 1 ||
    result.getDate() !== day
  ) {
    return null;
  }
  return result;
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}
