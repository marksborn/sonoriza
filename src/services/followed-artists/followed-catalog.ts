import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { spotifyFollowedArtistsCandidateCapability } from "@/services/data-policy/legacy-consumer-policy";
import type {
  ArtistReleaseResponse,
  FollowedArtistSummary,
  ReleaseTrackResponse,
} from "@/services/spotify/client";
import { SpotifyApiError } from "@/services/spotify/errors";

/**
 * DISCOVERY-FOLLOWED-01 (#564) Gate C — sampled catalog of followed artists.
 * Contract: docs/DISCOVERY-FOLLOWED-01-GATE-B.md.
 *
 * The follow list only BOUNDS which artists are read (PERSONAL §8.1). Artist
 * order uses Last.fm scrobbles only. Likes, Spotify listening state and
 * Last.fm only EXCLUDE known tracks. Nothing here is taste evidence, and
 * Gate C has no planner influence: it only fills a cache shown in Descobrir.
 */

export const FOLLOWED_CATALOG_POLICY = Object.freeze({
  artistsPerRefresh: 20,
  albumsPerArtist: 2,
  albumPageSize: 10,
  artistRecheckMs: 14 * 86_400_000,
  followedSyncMs: 7 * 86_400_000,
  minRefreshIntervalMs: 20 * 60 * 60_000,
  maxCandidates: 200,
  candidateRetentionMs: 60 * 86_400_000,
  maxPerAlbum: 2,
  maxPerArtist: 3,
  minDurationMs: 90_000,
  maxDurationMs: 10 * 60_000,
  lastFmRankWindowMs: 730 * 86_400_000,
  maxSampledAlbumIdsPerArtist: 60,
});

export type FollowedCatalogExclusion =
  | "NOT_OWN_RELEASE"
  | "NOT_PRIMARY_ARTIST"
  | "LIKED"
  | "HEARD_SPOTIFY_STATE"
  | "HEARD_LASTFM_NAME"
  | "VERSION_AMBIGUOUS"
  | "UNPLAYABLE"
  | "DURATION"
  | "CAP"
  | "DUPLICATE";

export type FollowedArtistCheck = {
  checkedAt: string;
  nextOffset: number;
  sampledAlbumIds: string[];
};

export type FollowedCatalogCandidate = {
  spotifyTrackId: string;
  uri: string;
  name: string;
  durationMs: number;
  artistId: string;
  artistName: string;
  albumId: string;
  albumName: string;
  albumType: string;
  releaseDate: string | null;
  imageUrl: string | null;
  reasons: string[];
  lastFmRank: number | null;
  addedAt: string;
};

export type FollowedCatalogEvidence = {
  followedSynced: boolean;
  followedReads: number;
  artistReads: number;
  albumReads: number;
  failures: number;
  firstFailure: string | null;
  providerBlocked: boolean;
  checkedArtistIds: string[];
  newCandidates: number;
  excluded: Partial<Record<FollowedCatalogExclusion, number>>;
};

export type FollowedCatalogReader = Readonly<{
  followedArtists: () => Promise<{ artists: FollowedArtistSummary[] }>;
  artistAlbums: (
    artistId: string,
    offset: number,
  ) => Promise<{ items: ArtistReleaseResponse[]; total: number | null }>;
  albumTracks: (albumId: string) => Promise<ReleaseTrackResponse[]>;
}>;

export type FollowedCatalogKnowledge = Readonly<{
  likedTrackIds: ReadonlySet<string>;
  heardTrackIds: ReadonlySet<string>;
  /** normalize(artist)|normalizeTitle(track) of every Last.fm scrobble. */
  lastFmTrackKeys: ReadonlySet<string>;
  /** normalize(artist) -> scrobbles in the ranking window. */
  lastFmArtistCounts: ReadonlyMap<string, number>;
}>;

export type FollowedCatalogState = Readonly<{
  followedArtists: FollowedArtistSummary[];
  followedSyncedAt: Date | null;
  artistChecks: Record<string, FollowedArtistCheck>;
  candidates: FollowedCatalogCandidate[];
}>;

/** Titles that do not identify one recording safely until #374 (ABSTAIN). */
const VERSION_PATTERN =
  /\b(remaster(ed)?|live|ao vivo|en vivo|demo|instrumental|ac[uú]stic[oa]?|acoustic|unplugged|remix(es)?|karaok[eê]|edit|version|vers[aã]o|mono|stereo|deluxe|anniversary|reissue|expanded|re-?recorded)\b/i;

export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Drops "- Remastered 2011", "(Live)", "[Demo]"-style suffixes before matching. */
export function normalizeTitle(value: string): string {
  const base = value
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, " ");
  return normalizeName(base);
}

export function isAmbiguousVersion(title: string): boolean {
  return VERSION_PATTERN.test(title);
}

/**
 * Due artists in rotation: never checked first, then the oldest check; ties
 * favor artists the user scrobbles most (Last.fm only). Artists without
 * Last.fm plays go last within the same check age.
 */
export function selectFollowedArtistsToCheck(input: {
  artists: readonly FollowedArtistSummary[];
  checks: Readonly<Record<string, FollowedArtistCheck>>;
  lastFmArtistCounts: ReadonlyMap<string, number>;
  now: Date;
  limit?: number;
  recheckMs?: number;
}): FollowedArtistSummary[] {
  const limit = input.limit ?? FOLLOWED_CATALOG_POLICY.artistsPerRefresh;
  const recheckMs = input.recheckMs ?? FOLLOWED_CATALOG_POLICY.artistRecheckMs;
  const nowMs = input.now.getTime();
  return input.artists
    .map((artist) => {
      const parsed = Date.parse(input.checks[artist.id]?.checkedAt ?? "");
      return {
        artist,
        at: Number.isFinite(parsed) ? parsed : 0,
        plays: input.lastFmArtistCounts.get(normalizeName(artist.name)) ?? 0,
      };
    })
    .filter((entry) => entry.at === 0 || nowMs - entry.at >= recheckMs)
    .sort(
      (a, b) =>
        a.at - b.at ||
        b.plays - a.plays ||
        a.artist.name.localeCompare(b.artist.name) ||
        a.artist.id.localeCompare(b.artist.id),
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.artist);
}

/** Own albums/singles of the artist, not sampled yet and not a reissue. */
export function selectAlbumsToSample(input: {
  artistId: string;
  items: readonly ArtistReleaseResponse[];
  sampledAlbumIds: ReadonlySet<string>;
  limit?: number;
  excluded: FollowedCatalogEvidence["excluded"];
}): ArtistReleaseResponse[] {
  const limit = input.limit ?? FOLLOWED_CATALOG_POLICY.albumsPerArtist;
  const chosen: ArtistReleaseResponse[] = [];
  for (const album of input.items) {
    if (chosen.length >= limit) break;
    if (!album.id || input.sampledAlbumIds.has(album.id)) continue;
    const ownRelease =
      (album.album_type === "album" || album.album_type === "single") &&
      album.artists?.[0]?.id === input.artistId;
    if (!ownRelease) {
      bump(input.excluded, "NOT_OWN_RELEASE");
      continue;
    }
    if (isAmbiguousVersion(album.name ?? "")) {
      bump(input.excluded, "VERSION_AMBIGUOUS");
      continue;
    }
    chosen.push(album);
  }
  return chosen;
}

export function classifyFollowedTrack(input: {
  track: ReleaseTrackResponse;
  artist: FollowedArtistSummary;
  knowledge: FollowedCatalogKnowledge;
}): FollowedCatalogExclusion | null {
  const { track, artist, knowledge } = input;
  if (!track.id || !track.uri) return "UNPLAYABLE";
  if (track.artists?.[0]?.id && track.artists[0].id !== artist.id) return "NOT_PRIMARY_ARTIST";
  if (track.is_playable === false) return "UNPLAYABLE";
  const duration = track.duration_ms ?? 0;
  if (
    duration < FOLLOWED_CATALOG_POLICY.minDurationMs ||
    duration > FOLLOWED_CATALOG_POLICY.maxDurationMs
  ) {
    return "DURATION";
  }
  if (isAmbiguousVersion(track.name ?? "")) return "VERSION_AMBIGUOUS";
  if (knowledge.likedTrackIds.has(track.id)) return "LIKED";
  if (knowledge.heardTrackIds.has(track.id)) return "HEARD_SPOTIFY_STATE";
  if (knowledge.lastFmTrackKeys.has(lastFmTrackKey(artist.name, track.name ?? ""))) {
    return "HEARD_LASTFM_NAME";
  }
  return null;
}

export function lastFmTrackKey(artistName: string, trackName: string): string {
  return `${normalizeName(artistName)}|${normalizeTitle(trackName)}`;
}

/**
 * Keeps candidates of still-followed artists inside the retention window that
 * are still unknown, fresh ones first, with per-artist and total caps.
 */
export function mergeFollowedCandidates(input: {
  previous: readonly FollowedCatalogCandidate[];
  fresh: readonly FollowedCatalogCandidate[];
  followedIds: ReadonlySet<string>;
  knowledge: Pick<FollowedCatalogKnowledge, "likedTrackIds" | "heardTrackIds">;
  now: Date;
}): FollowedCatalogCandidate[] {
  const nowMs = input.now.getTime();
  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  const output: FollowedCatalogCandidate[] = [];
  for (const candidate of [...input.fresh, ...input.previous]) {
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    if (!input.followedIds.has(candidate.artistId)) continue;
    const addedMs = Date.parse(candidate.addedAt);
    if (!Number.isFinite(addedMs) || nowMs - addedMs > FOLLOWED_CATALOG_POLICY.candidateRetentionMs) continue;
    if (input.knowledge.likedTrackIds.has(candidate.spotifyTrackId)) continue;
    if (input.knowledge.heardTrackIds.has(candidate.spotifyTrackId)) continue;
    const count = perArtist.get(candidate.artistId) ?? 0;
    if (count >= FOLLOWED_CATALOG_POLICY.maxPerArtist) continue;
    perArtist.set(candidate.artistId, count + 1);
    output.push(candidate);
    if (output.length >= FOLLOWED_CATALOG_POLICY.maxCandidates) break;
  }
  return output;
}

export function shouldPersistFollowedCatalog(evidence: FollowedCatalogEvidence): boolean {
  if (evidence.providerBlocked) return false;
  const reads = evidence.artistReads + evidence.albumReads;
  return reads === 0 || evidence.failures * 2 <= reads;
}

/**
 * One refresh without database access: weekly follow sync when due, then the
 * sampled read of up to `artistsPerRefresh` artists. Stops at the first quota
 * or rate-limit block. Never writes to Spotify.
 */
export async function collectFollowedCatalog(input: {
  previous: FollowedCatalogState | null;
  reader: FollowedCatalogReader;
  knowledge: FollowedCatalogKnowledge;
  now: Date;
}): Promise<{ state: FollowedCatalogState; evidence: FollowedCatalogEvidence }> {
  const { reader, knowledge, now } = input;
  const evidence: FollowedCatalogEvidence = {
    followedSynced: false,
    followedReads: 0,
    artistReads: 0,
    albumReads: 0,
    failures: 0,
    firstFailure: null,
    providerBlocked: false,
    checkedArtistIds: [],
    newCandidates: 0,
    excluded: {},
  };
  const fail = (error: unknown) => {
    evidence.failures += 1;
    evidence.firstFailure ??= error instanceof Error ? error.message.slice(0, 200) : String(error);
    if (
      error instanceof SpotifyApiError &&
      (error.kind === "QUOTA_EXCEEDED" || error.kind === "RATE_LIMITED")
    ) {
      evidence.providerBlocked = true;
    }
  };

  let followedArtists = input.previous?.followedArtists ?? [];
  let followedSyncedAt = input.previous?.followedSyncedAt ?? null;
  const syncDue =
    !followedSyncedAt ||
    now.getTime() - followedSyncedAt.getTime() >= FOLLOWED_CATALOG_POLICY.followedSyncMs;
  if (syncDue) {
    try {
      evidence.followedReads += 1;
      followedArtists = (await reader.followedArtists()).artists;
      followedSyncedAt = now;
      evidence.followedSynced = true;
    } catch (error) {
      fail(error);
      // Without a usable follow list nothing else may be read.
      return {
        state: input.previous ?? {
          followedArtists: [],
          followedSyncedAt: null,
          artistChecks: {},
          candidates: [],
        },
        evidence: { ...evidence, providerBlocked: true },
      };
    }
  }

  const followedIds = new Set(followedArtists.map((artist) => artist.id));
  const artistChecks: Record<string, FollowedArtistCheck> = {};
  for (const [artistId, check] of Object.entries(input.previous?.artistChecks ?? {})) {
    if (followedIds.has(artistId)) artistChecks[artistId] = check;
  }

  const due = selectFollowedArtistsToCheck({
    artists: followedArtists,
    checks: artistChecks,
    lastFmArtistCounts: knowledge.lastFmArtistCounts,
    now,
  });
  const lastFmRank = rankByLastFm(followedArtists, knowledge.lastFmArtistCounts);
  const knownUris = new Set((input.previous?.candidates ?? []).map((candidate) => candidate.uri));
  const fresh: FollowedCatalogCandidate[] = [];

  for (const artist of due) {
    if (evidence.providerBlocked) break;
    const check = artistChecks[artist.id] ?? { checkedAt: "", nextOffset: 0, sampledAlbumIds: [] };
    let page: Awaited<ReturnType<FollowedCatalogReader["artistAlbums"]>>;
    try {
      evidence.artistReads += 1;
      page = await reader.artistAlbums(artist.id, check.nextOffset);
    } catch (error) {
      fail(error);
      continue;
    }
    const sampled = new Set(check.sampledAlbumIds);
    const albums = selectAlbumsToSample({
      artistId: artist.id,
      items: page.items,
      sampledAlbumIds: sampled,
      excluded: evidence.excluded,
    });
    let artistTaken = 0;
    for (const album of albums) {
      if (evidence.providerBlocked) break;
      let tracks: ReleaseTrackResponse[];
      try {
        evidence.albumReads += 1;
        tracks = await reader.albumTracks(album.id!);
      } catch (error) {
        fail(error);
        continue;
      }
      sampled.add(album.id!);
      let albumTaken = 0;
      for (const track of tracks) {
        const exclusion = classifyFollowedTrack({ track, artist, knowledge });
        if (exclusion) {
          bump(evidence.excluded, exclusion);
          continue;
        }
        if (knownUris.has(track.uri!)) {
          bump(evidence.excluded, "DUPLICATE");
          continue;
        }
        if (
          albumTaken >= FOLLOWED_CATALOG_POLICY.maxPerAlbum ||
          artistTaken >= FOLLOWED_CATALOG_POLICY.maxPerArtist
        ) {
          bump(evidence.excluded, "CAP");
          continue;
        }
        knownUris.add(track.uri!);
        albumTaken += 1;
        artistTaken += 1;
        fresh.push({
          spotifyTrackId: track.id!,
          uri: track.uri!,
          name: track.name ?? "",
          durationMs: track.duration_ms ?? 0,
          artistId: artist.id,
          artistName: artist.name,
          albumId: album.id!,
          albumName: album.name ?? "",
          albumType: album.album_type ?? "album",
          releaseDate: album.release_date ?? null,
          imageUrl: album.images?.[0]?.url ?? null,
          reasons: ["FOLLOWED_ARTIST", "NOT_LIKED", "NO_KNOWN_PLAY", "LASTFM_RANK"],
          lastFmRank: lastFmRank.get(artist.id) ?? null,
          addedAt: now.toISOString(),
        });
      }
    }
    const total = page.total ?? page.items.length;
    const nextOffset = check.nextOffset + FOLLOWED_CATALOG_POLICY.albumPageSize;
    artistChecks[artist.id] = {
      checkedAt: now.toISOString(),
      nextOffset: nextOffset >= total ? 0 : nextOffset,
      sampledAlbumIds: [...sampled].slice(-FOLLOWED_CATALOG_POLICY.maxSampledAlbumIdsPerArtist),
    };
    evidence.checkedArtistIds.push(artist.id);
  }

  const candidates = mergeFollowedCandidates({
    previous: input.previous?.candidates ?? [],
    fresh,
    followedIds,
    knowledge,
    now,
  });
  evidence.newCandidates = fresh.length;
  return {
    state: { followedArtists, followedSyncedAt, artistChecks, candidates },
    evidence,
  };
}

/** 1 = most scrobbled followed artist; null without Last.fm plays. */
function rankByLastFm(
  artists: readonly FollowedArtistSummary[],
  counts: ReadonlyMap<string, number>,
): Map<string, number> {
  const ranked = artists
    .map((artist) => ({ id: artist.id, plays: counts.get(normalizeName(artist.name)) ?? 0 }))
    .filter((entry) => entry.plays > 0)
    .sort((a, b) => b.plays - a.plays);
  return new Map(ranked.map((entry, index) => [entry.id, index + 1]));
}

function bump(
  counts: FollowedCatalogEvidence["excluded"],
  reason: FollowedCatalogExclusion,
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

// --- Persistence ------------------------------------------------------------

export async function readFollowedCatalog(userId: string) {
  const row = await prisma.followedArtistCatalogSnapshot.findUnique({ where: { userId } });
  if (!row) return null;
  return {
    fetchedAt: row.fetchedAt,
    followedSyncedAt: row.followedSyncedAt,
    followedCount: row.followedCount,
    followedArtists: asArray<FollowedArtistSummary>(row.followedArtists),
    artistChecks: (row.artistChecks ?? {}) as unknown as Record<string, FollowedArtistCheck>,
    candidates: asArray<FollowedCatalogCandidate>(row.candidates),
    evidence: row.evidence as unknown as FollowedCatalogEvidence & { checkedTotal?: number },
  };
}

export async function loadFollowedCatalogKnowledge(
  userId: string,
  now: Date,
): Promise<FollowedCatalogKnowledge> {
  const since = new Date(now.getTime() - FOLLOWED_CATALOG_POLICY.lastFmRankWindowMs);
  const [liked, heard, artistCounts, trackPairs] = await Promise.all([
    prisma.likedTrackPreference.findMany({
      where: { userId, isLiked: true },
      select: { spotifyTrackId: true },
    }),
    prisma.trackListeningState.findMany({ where: { userId }, select: { spotifyTrackId: true } }),
    prisma.trackListeningEvent.groupBy({
      by: ["artistName"],
      where: { userId, source: "LASTFM_SCROBBLE", playedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.trackListeningEvent.groupBy({
      by: ["artistName", "trackName"],
      where: { userId, source: "LASTFM_SCROBBLE" },
    }),
  ]);
  const lastFmArtistCounts = new Map<string, number>();
  for (const row of artistCounts) {
    const key = normalizeName(row.artistName);
    lastFmArtistCounts.set(key, (lastFmArtistCounts.get(key) ?? 0) + row._count._all);
  }
  return {
    likedTrackIds: new Set(liked.map((row) => row.spotifyTrackId)),
    heardTrackIds: new Set(heard.map((row) => row.spotifyTrackId)),
    lastFmTrackKeys: new Set(trackPairs.map((row) => lastFmTrackKey(row.artistName, row.trackName))),
    lastFmArtistCounts,
  };
}

export class FollowedCatalogPolicyBlockedError extends Error {
  constructor() {
    super("Policy capability for followed artists is not allowed.");
    this.name = "FollowedCatalogPolicyBlockedError";
  }
}

/** Refresh + persist. An incomplete or blocked read never replaces a good snapshot. */
export async function refreshFollowedCatalog(input: {
  userId: string;
  reader: FollowedCatalogReader;
  now?: Date;
}): Promise<{ persisted: boolean; evidence: FollowedCatalogEvidence }> {
  if (!spotifyFollowedArtistsCandidateCapability().allowed) {
    throw new FollowedCatalogPolicyBlockedError();
  }
  const now = input.now ?? new Date();
  const [previousRow, knowledge] = await Promise.all([
    readFollowedCatalog(input.userId),
    loadFollowedCatalogKnowledge(input.userId, now),
  ]);
  const previous: FollowedCatalogState | null = previousRow
    ? {
        followedArtists: previousRow.followedArtists,
        followedSyncedAt: previousRow.followedSyncedAt,
        artistChecks: previousRow.artistChecks,
        candidates: previousRow.candidates,
      }
    : null;
  const { state, evidence } = await collectFollowedCatalog({
    previous,
    reader: input.reader,
    knowledge,
    now,
  });
  if (!shouldPersistFollowedCatalog(evidence) || !state.followedSyncedAt) {
    return { persisted: false, evidence };
  }
  const data = {
    fetchedAt: now,
    followedSyncedAt: state.followedSyncedAt,
    followedCount: state.followedArtists.length,
    candidateCount: state.candidates.length,
    followedArtists: state.followedArtists as unknown as Prisma.InputJsonValue,
    artistChecks: state.artistChecks as unknown as Prisma.InputJsonValue,
    candidates: state.candidates as unknown as Prisma.InputJsonValue,
    evidence: {
      ...evidence,
      checkedTotal: Object.keys(state.artistChecks).length,
    } as unknown as Prisma.InputJsonValue,
  };
  await prisma.followedArtistCatalogSnapshot.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, ...data },
    update: data,
  });
  return { persisted: true, evidence };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
