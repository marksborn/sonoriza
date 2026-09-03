import type {
  LastFmClient,
  LastFmRecentTracksPage,
} from "@/services/lastfm/client";

import type { LastFmRecentObservation } from "./lastfm-coverage";

export type LastFmRecentTracksReader = Pick<LastFmClient, "getRecentTracksPage">;

export const MUSIC_06_LASTFM_DEFAULT_MAX_PAGES = 10;

/**
 * MUSIC-06 Gate 2 read-only provider adapter.
 *
 * Reads a bounded Last.fm `user.getrecenttracks` window and reports whether the
 * provider pagination was fully observed. It does not write TrackListeningEvent,
 * MusicPreferenceSignal or any other Sonoriza state.
 */
export async function readLastFmRecentObservation(input: {
  client: LastFmRecentTracksReader;
  username: string;
  from: Date;
  to: Date;
  observedAt?: Date;
  maxPages?: number;
}): Promise<LastFmRecentObservation> {
  const username = input.username.trim();
  if (!username) throw new Error("MUSIC-06 Last.fm reader requires username");
  if (!(input.from instanceof Date) || !Number.isFinite(input.from.getTime())) {
    throw new Error("MUSIC-06 Last.fm reader requires a valid from date");
  }
  if (!(input.to instanceof Date) || !Number.isFinite(input.to.getTime())) {
    throw new Error("MUSIC-06 Last.fm reader requires a valid to date");
  }
  if (input.from >= input.to) {
    throw new Error("MUSIC-06 Last.fm reader requires from < to");
  }

  const maxPages = positiveInt(
    input.maxPages ?? MUSIC_06_LASTFM_DEFAULT_MAX_PAGES,
    "maxPages",
  );
  const observedAt = input.observedAt ?? new Date();
  const pages: LastFmRecentTracksPage[] = [];

  const first = await input.client.getRecentTracksPage({
    username,
    page: 1,
    from: input.from,
    to: input.to,
  });
  pages.push(first);

  // Last.fm may return totalPages=0 for an empty window. The first request is
  // still the complete representation in that case.
  const reportedTotalPages = Math.max(0, first.totalPages);
  const pagesToFetch = Math.min(Math.max(1, reportedTotalPages), maxPages);

  for (let page = 2; page <= pagesToFetch; page += 1) {
    pages.push(
      await input.client.getRecentTracksPage({
        username,
        page,
        from: input.from,
        to: input.to,
      }),
    );
  }

  const totalPages = pages.reduce(
    (max, page) => Math.max(max, page.totalPages),
    reportedTotalPages,
  );
  const complete = totalPages <= pages.length;
  const byEventKey = new Map<string, (typeof first.events)[number]>();

  for (const page of pages) {
    for (const event of page.events) {
      if (!byEventKey.has(event.sourceEventKey)) {
        byEventKey.set(event.sourceEventKey, event);
      }
    }
  }

  const scrobbles = [...byEventKey.values()].sort(
    (left, right) => left.playedAt.getTime() - right.playedAt.getTime(),
  );

  return {
    username: first.username || username,
    observedAt,
    requestedFrom: input.from,
    requestedTo: input.to,
    pagesFetched: pages.length,
    totalPages,
    providerTotal: first.total,
    complete,
    nowPlayingCount: pages.reduce(
      (sum, page) => sum + page.nowPlayingCount,
      0,
    ),
    invalidCount: pages.reduce((sum, page) => sum + page.invalidCount, 0),
    scrobbles,
  };
}

function positiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MUSIC-06 Last.fm reader ${label} must be a positive integer`);
  }
  return value;
}
