import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SpotifyBackoffActiveError } from "@/services/spotify/backoff";
import { SpotifyApiError } from "@/services/spotify/errors";
import type {
  ArtistReleaseResponse,
  ReleaseTrackResponse,
} from "@/services/spotify/client";

/**
 * RELEASES-01 (#161) Gate 1 — radar de lançamentos.
 *
 * Seeds are the user's own artists: active liked-track affinity plus the most
 * played primary artists of the last 90 days. For each seed the first page of
 * /artists/{id}/albums (albums + singles, newest first) is read and releases
 * inside the window are kept; their tracks come from /albums/{id}/tracks.
 * Feb 2026 removed /browse/new-releases, top-tracks and batch album/track
 * reads, so everything here is single-item and bounded.
 *
 * Gate 1 only caches and displays. It never writes to Spotify and does not
 * influence planning.
 */

export const RELEASE_RADAR_DEFAULTS = Object.freeze({
  windowDays: 30,
  maxSeeds: 50,
  maxReleases: 40,
  minRefreshIntervalMs: 10 * 60_000,
});

export type ReleaseRadarSeed = Readonly<{
  spotifyArtistId: string;
  artistName: string | null;
  reasons: ReadonlyArray<"LIKED_TRACKS" | "RECENT_LISTENING">;
  weight: number;
}>;

export type ReleaseRadarTrack = Readonly<{
  spotifyTrackId: string;
  uri: string;
  name: string;
  durationMs: number;
  alreadyHeard: boolean;
}>;

export type ReleaseRadarRelease = Readonly<{
  albumId: string;
  name: string;
  albumType: string;
  releaseDate: string;
  artists: string[];
  imageUrl: string | null;
  seedArtistId: string;
  tracks: ReleaseRadarTrack[];
}>;

export type ReleaseRadarEvidence = Readonly<{
  seedCount: number;
  artistReads: number;
  releaseReads: number;
  failures: number;
  firstFailure: string | null;
  /** Quota/rate limit/backoff hit: reading stopped at the first such error. */
  providerBlocked: boolean;
}>;

/** Errors after which every further Spotify read would only fail too. */
export function isSpotifyProviderBlock(error: unknown): boolean {
  return (
    error instanceof SpotifyBackoffActiveError ||
    (error instanceof SpotifyApiError &&
      (error.kind === "QUOTA_EXCEEDED" || error.kind === "RATE_LIMITED"))
  );
}

export type ReleaseRadarReader = Readonly<{
  artistReleases: (artistId: string) => Promise<ArtistReleaseResponse[]>;
  releaseTracks: (albumId: string) => Promise<ReleaseTrackResponse[]>;
}>;

/** True when the release date (any precision) falls inside the window. */
export function isRecentRelease(
  releaseDate: string | undefined,
  precision: ArtistReleaseResponse["release_date_precision"],
  now: Date,
  windowDays: number,
): boolean {
  if (!releaseDate) return false;
  // Year/month precision are treated as their LAST day so a release from the
  // current month or year is not dropped; never in the future.
  let date: Date | null = null;
  if (precision === "day" || /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    date = new Date(`${releaseDate.slice(0, 10)}T00:00:00Z`);
  } else if (precision === "month" || /^\d{4}-\d{2}$/.test(releaseDate)) {
    const [year, month] = releaseDate.split("-").map(Number);
    date = new Date(Date.UTC(year!, month!, 0));
  } else if (/^\d{4}$/.test(releaseDate)) {
    return false; // a bare year is too coarse to call "recent"
  }
  if (!date || Number.isNaN(date.getTime())) return false;
  const ageMs = now.getTime() - date.getTime();
  return ageMs >= -86_400_000 && ageMs <= windowDays * 86_400_000;
}

/** Merges both seed sources by Spotify artist id, liked affinity first. */
export function mergeReleaseRadarSeeds(
  liked: ReadonlyArray<{ spotifyArtistId: string; artistName: string | null; count: number }>,
  listened: ReadonlyArray<{ spotifyArtistId: string; artistName: string | null; count: number }>,
  maxSeeds: number,
): ReleaseRadarSeed[] {
  const byId = new Map<string, { artistName: string | null; reasons: Set<string>; weight: number }>();
  const add = (
    rows: typeof liked,
    reason: "LIKED_TRACKS" | "RECENT_LISTENING",
  ) => {
    for (const row of rows) {
      const id = row.spotifyArtistId.trim();
      if (!/^[A-Za-z0-9]{22}$/.test(id)) continue;
      const entry = byId.get(id) ?? { artistName: row.artistName, reasons: new Set(), weight: 0 };
      entry.reasons.add(reason);
      entry.weight += row.count;
      entry.artistName ??= row.artistName;
      byId.set(id, entry);
    }
  };
  add(liked, "LIKED_TRACKS");
  add(listened, "RECENT_LISTENING");
  return [...byId.entries()]
    .sort((a, b) => b[1].reasons.size - a[1].reasons.size || b[1].weight - a[1].weight)
    .slice(0, maxSeeds)
    .map(([spotifyArtistId, entry]) => ({
      spotifyArtistId,
      artistName: entry.artistName,
      reasons: [...entry.reasons] as ReleaseRadarSeed["reasons"],
      weight: entry.weight,
    }));
}

export async function collectRecentReleases(input: {
  reader: ReleaseRadarReader;
  seeds: readonly ReleaseRadarSeed[];
  heardTrackIds: ReadonlySet<string>;
  now: Date;
  windowDays?: number;
  maxReleases?: number;
}): Promise<{ releases: ReleaseRadarRelease[]; evidence: ReleaseRadarEvidence }> {
  const windowDays = input.windowDays ?? RELEASE_RADAR_DEFAULTS.windowDays;
  const maxReleases = input.maxReleases ?? RELEASE_RADAR_DEFAULTS.maxReleases;
  const found = new Map<string, { release: ArtistReleaseResponse; seedArtistId: string }>();
  let artistReads = 0;
  let releaseReads = 0;
  let failures = 0;
  let firstFailure: string | null = null;
  let providerBlocked = false;
  const fail = (error: unknown) => {
    failures += 1;
    firstFailure ??= error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN";
    if (isSpotifyProviderBlock(error)) providerBlocked = true;
  };

  for (const seed of input.seeds) {
    if (providerBlocked) break;
    try {
      artistReads += 1;
      for (const release of await input.reader.artistReleases(seed.spotifyArtistId)) {
        if (!release.id || found.has(release.id)) continue;
        if (!isRecentRelease(release.release_date, release.release_date_precision, input.now, windowDays)) {
          continue;
        }
        found.set(release.id, { release, seedArtistId: seed.spotifyArtistId });
      }
    } catch (error) {
      fail(error);
    }
  }

  const newestFirst = [...found.values()]
    .sort((a, b) => (b.release.release_date ?? "").localeCompare(a.release.release_date ?? ""))
    .slice(0, maxReleases);

  const releases: ReleaseRadarRelease[] = [];
  for (const { release, seedArtistId } of newestFirst) {
    if (providerBlocked) break;
    let tracks: ReleaseTrackResponse[] = [];
    try {
      releaseReads += 1;
      tracks = await input.reader.releaseTracks(release.id!);
    } catch (error) {
      fail(error);
      continue;
    }
    const playable = tracks.flatMap((track): ReleaseRadarTrack[] =>
      track.id && track.uri?.startsWith("spotify:track:") && track.is_playable !== false
        ? [{
            spotifyTrackId: track.id,
            uri: track.uri,
            name: track.name ?? "",
            durationMs: Math.max(0, Math.trunc(track.duration_ms ?? 0)),
            alreadyHeard: input.heardTrackIds.has(track.id),
          }]
        : [],
    );
    if (playable.length === 0) continue;
    releases.push({
      albumId: release.id!,
      name: release.name ?? "",
      albumType: release.album_type ?? "album",
      releaseDate: release.release_date ?? "",
      artists: (release.artists ?? []).flatMap((artist) => (artist.name ? [artist.name] : [])),
      imageUrl: pickImage(release.images),
      seedArtistId,
      tracks: playable,
    });
  }

  return {
    releases,
    evidence: {
      seedCount: input.seeds.length,
      artistReads,
      releaseReads,
      failures,
      firstFailure,
      providerBlocked,
    },
  };
}

function pickImage(images: ArtistReleaseResponse["images"]): string | null {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((image) => (image.width ?? 0) >= 160) ?? sorted.at(-1))?.url ?? null;
}

export async function loadReleaseRadarSeeds(
  userId: string,
  now: Date,
  maxSeeds = RELEASE_RADAR_DEFAULTS.maxSeeds,
): Promise<ReleaseRadarSeed[]> {
  const since = new Date(now.getTime() - 90 * 86_400_000);
  const [liked, listened] = await Promise.all([
    prisma.artistAffinityState.findMany({
      where: { userId, active: true },
      orderBy: { likedTrackCount: "desc" },
      take: maxSeeds,
      select: { spotifyArtistId: true, artistName: true, likedTrackCount: true },
    }),
    prisma.trackListeningEvent.groupBy({
      by: ["primaryArtistId", "artistName"],
      where: { userId, playedAt: { gte: since }, primaryArtistId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { primaryArtistId: "desc" } },
      take: maxSeeds,
    }),
  ]);
  return mergeReleaseRadarSeeds(
    liked.map((row) => ({
      spotifyArtistId: row.spotifyArtistId,
      artistName: row.artistName,
      count: row.likedTrackCount,
    })),
    listened.map((row) => ({
      spotifyArtistId: row.primaryArtistId ?? "",
      artistName: row.artistName,
      count: row._count._all,
    })),
    maxSeeds,
  );
}

export async function refreshReleaseRadar(input: {
  userId: string;
  reader: ReleaseRadarReader;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const seeds = await loadReleaseRadarSeeds(input.userId, now);
  const heard = await prisma.trackListeningState.findMany({
    where: { userId: input.userId },
    select: { spotifyTrackId: true },
  });
  const { releases, evidence } = await collectRecentReleases({
    reader: input.reader,
    seeds,
    heardTrackIds: new Set(heard.map((row) => row.spotifyTrackId)),
    now,
  });
  // An incomplete read must never replace a good radar with an empty one.
  if (!shouldPersistReleaseRadar(evidence)) {
    return { releases, evidence, persisted: false as const };
  }
  const data = {
    fetchedAt: now,
    windowDays: RELEASE_RADAR_DEFAULTS.windowDays,
    seedCount: seeds.length,
    releaseCount: releases.length,
    releases: releases as unknown as Prisma.InputJsonValue,
    evidence: {
      ...evidence,
      seeds: seeds.map((seed) => ({ id: seed.spotifyArtistId, reasons: seed.reasons })),
    } as unknown as Prisma.InputJsonValue,
  };
  await prisma.releaseRadarSnapshot.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, ...data },
    update: data,
  });
  return { releases, evidence, persisted: true as const };
}

/** Keep the previous radar when the provider blocked us or most reads failed. */
export function shouldPersistReleaseRadar(evidence: ReleaseRadarEvidence): boolean {
  if (evidence.providerBlocked) return false;
  const reads = evidence.artistReads + evidence.releaseReads;
  return reads === 0 || evidence.failures * 2 < reads;
}

export async function readReleaseRadar(userId: string) {
  const row = await prisma.releaseRadarSnapshot.findUnique({ where: { userId } });
  if (!row) return null;
  return {
    fetchedAt: row.fetchedAt,
    windowDays: row.windowDays,
    seedCount: row.seedCount,
    releases: Array.isArray(row.releases) ? (row.releases as unknown as ReleaseRadarRelease[]) : [],
    evidence: row.evidence as unknown as ReleaseRadarEvidence,
  };
}
