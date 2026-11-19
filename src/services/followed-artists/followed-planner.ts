import { prisma } from "@/lib/prisma";
import { spotifyFollowedArtistsCandidateCapability } from "@/services/data-policy/legacy-consumer-policy";
import type { TargetDiscoveryIntensity } from "@/services/music-discovery/target-discovery-policy";
import type { Candidate } from "@/services/playlist-planner/types";

import { readFollowedCatalog, type FollowedCatalogCandidate } from "./followed-catalog";

/**
 * DISCOVERY-FOLLOWED-01 (#564) Gate D — "Artistas que sigo" family of
 * Descobrir por destino (contract: docs/DISCOVERY-FOLLOWED-01-GATE-B.md §5).
 *
 * Reads only the cached snapshot (no provider call during generation). The
 * capability is re-evaluated here and fails closed. Per target and generation
 * the count is capped by intensity (1/2/3) and by 5% of the estimated music
 * tracks (minimum 1). An artist appears at most once per generation and not
 * again within 7 days of a published item from this catalog. Candidates still
 * pass the run's cooldown/repeat/"Não tocar mais" filters.
 *
 * FOLLOWED_ARTISTS_PLANNER_MODE: OFF (default) does nothing; SHADOW only
 * records what would enter; ACTIVE changes the pool.
 */

export type FollowedPlannerMode = "OFF" | "SHADOW" | "ACTIVE";

export const FOLLOWED_PLANNER_POLICY = Object.freeze({
  ceilingByIntensity: { CONSERVATIVE: 1, BALANCED: 2, EXPLORATORY: 3 } as Record<
    TargetDiscoveryIntensity,
    number
  >,
  maxMusicShare: 0.05,
  averageTrackMs: 240_000,
  artistSpacingMs: 7 * 86_400_000,
  spreadEvery: 4,
  // Novidades use index % 4 === 1; this family uses 3 so the two never sit together.
  spreadOffset: 3,
});

export function resolveFollowedPlannerMode(value: string | null | undefined): FollowedPlannerMode {
  const normalized = value?.trim().toUpperCase();
  return normalized === "SHADOW" || normalized === "ACTIVE" ? normalized : "OFF";
}

/** Ceiling, not quota: min(intensity cap, max(1, 5% of estimated music tracks)). */
export function followedCeiling(input: {
  intensity: TargetDiscoveryIntensity;
  targetDurationMs: number;
  podcastPercent: number;
}): number {
  const musicShare = Math.min(1, Math.max(0, 1 - (input.podcastPercent || 0) / 100));
  const estimatedMusicTracks = Math.floor(
    (Math.max(0, input.targetDurationMs) * musicShare) / FOLLOWED_PLANNER_POLICY.averageTrackMs,
  );
  const shareCap = Math.max(1, Math.floor(estimatedMusicTracks * FOLLOWED_PLANNER_POLICY.maxMusicShare));
  return Math.min(FOLLOWED_PLANNER_POLICY.ceilingByIntensity[input.intensity], shareCap);
}

export type FollowedCandidateSelection = Readonly<{
  candidates: Candidate[];
  spacingExcluded: number;
}>;

/** Last.fm order (the only allowed ordering), one track per artist, spacing applied. */
export function followedCandidatesForPlanner(
  catalog: readonly FollowedCatalogCandidate[],
  recentArtistIds: ReadonlySet<string>,
): FollowedCandidateSelection {
  let spacingExcluded = 0;
  const seenArtists = new Set<string>();
  const candidates: Candidate[] = [];
  const ordered = [...catalog].sort(
    (a, b) =>
      (a.lastFmRank ?? Number.MAX_SAFE_INTEGER) - (b.lastFmRank ?? Number.MAX_SAFE_INTEGER) ||
      b.addedAt.localeCompare(a.addedAt),
  );
  for (const track of ordered) {
    if (recentArtistIds.has(track.artistId)) {
      spacingExcluded += 1;
      continue;
    }
    if (seenArtists.has(track.artistId) || track.durationMs <= 0) continue;
    seenArtists.add(track.artistId);
    candidates.push({
      uri: track.uri,
      type: "MUSIC",
      title: track.name,
      subtitle: track.artistName,
      spotifyTrackId: track.spotifyTrackId,
      primaryArtistId: track.artistId,
      primaryArtistName: track.artistName,
      albumId: track.albumId,
      albumName: track.albumName,
      durationMs: track.durationMs,
      ...(track.releaseDate ? { releaseDate: track.releaseDate } : {}),
    });
  }
  return { candidates, spacingExcluded };
}

/**
 * Spreads up to `limit` candidates through the pool at index % every === offset,
 * skipping URIs already in the pool or reserved by another family (Novidades wins).
 */
export function spreadFollowedIntoPool(
  pool: readonly Candidate[],
  followed: readonly Candidate[],
  limit: number,
  reservedUris: ReadonlySet<string> = new Set(),
): { pool: Candidate[]; injected: Candidate[] } {
  const present = new Set(pool.map((candidate) => candidate.uri));
  const injected = followed
    .filter((candidate) => !present.has(candidate.uri) && !reservedUris.has(candidate.uri))
    .slice(0, Math.max(0, limit));
  if (injected.length === 0) return { pool: [...pool], injected };
  const { spreadEvery, spreadOffset } = FOLLOWED_PLANNER_POLICY;
  const result: Candidate[] = [];
  let next = 0;
  for (let index = 0; index < pool.length; index += 1) {
    if (next < injected.length && index % spreadEvery === spreadOffset) result.push(injected[next++]!);
    result.push(pool[index]!);
  }
  while (next < injected.length) result.push(injected[next++]!);
  return { pool: result, injected };
}

export type FollowedPlannerInput = Readonly<{
  status: "OK" | "POLICY_BLOCKED" | "NO_CATALOG";
  catalogFetchedAt: Date | null;
  catalog: FollowedCatalogCandidate[];
  recentArtistIds: Set<string>;
}>;

/** DB only: snapshot plus artists published from it in the last 7 days. */
export async function loadFollowedPlannerInput(userId: string, now = new Date()): Promise<FollowedPlannerInput> {
  if (!spotifyFollowedArtistsCandidateCapability().allowed) {
    return { status: "POLICY_BLOCKED", catalogFetchedAt: null, catalog: [], recentArtistIds: new Set() };
  }
  const snapshot = await readFollowedCatalog(userId);
  if (!snapshot) {
    return { status: "NO_CATALOG", catalogFetchedAt: null, catalog: [], recentArtistIds: new Set() };
  }
  const uris = snapshot.candidates.map((candidate) => candidate.uri);
  const artistByUri = new Map(snapshot.candidates.map((candidate) => [candidate.uri, candidate.artistId]));
  const recentArtistIds = new Set<string>();
  if (uris.length > 0) {
    // Catalog URIs are by construction unliked/unheard tracks, so a published
    // item with one of them is an exposure from this family.
    const published = await prisma.generationItem.findMany({
      where: {
        spotifyUri: { in: uris },
        run: {
          userId,
          simulation: false,
          status: { in: ["SUCCESS", "PARTIAL"] },
          startedAt: { gte: new Date(now.getTime() - FOLLOWED_PLANNER_POLICY.artistSpacingMs) },
        },
      },
      select: { spotifyUri: true, primaryArtistId: true },
    });
    for (const item of published) {
      const artistId = item.primaryArtistId ?? artistByUri.get(item.spotifyUri);
      if (artistId) recentArtistIds.add(artistId);
    }
  }
  return {
    status: "OK",
    catalogFetchedAt: snapshot.fetchedAt,
    catalog: snapshot.candidates,
    recentArtistIds,
  };
}

export type FollowedTargetReview = Readonly<{
  mode: FollowedPlannerMode;
  label: string;
  titles: string[];
}>;

/** Reads `summary.targetDiscoveryRuntime.evidence.followedArtists` for the review screen. */
export function readFollowedTargetReviews(summary: unknown): ReadonlyMap<string, FollowedTargetReview> {
  const reviews = new Map<string, FollowedTargetReview>();
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const entries = record(record(record(summary)?.targetDiscoveryRuntime)?.evidence)?.followedArtists;
  if (!Array.isArray(entries)) return reviews;
  for (const raw of entries) {
    const entry = record(raw);
    const targetId = typeof entry?.targetPlaylistId === "string" ? entry.targetPlaylistId : null;
    if (!entry || !targetId) continue;
    const mode = resolveFollowedPlannerMode(typeof entry.mode === "string" ? entry.mode : null);
    const injected = Array.isArray(entry.injected) ? entry.injected.map(record) : [];
    const titles = injected.flatMap((item) =>
      typeof item?.title === "string"
        ? [typeof item.artists === "string" ? `${item.title} — ${item.artists}` : item.title]
        : [],
    );
    let label: string;
    if (entry.status === "POLICY_BLOCKED") {
      label = "bloqueado pela política de dados";
    } else if (entry.status === "NO_CATALOG") {
      label = "catálogo vazio; atualize em Descobrir → Seguidos";
    } else if (titles.length === 0) {
      label = "nenhuma faixa elegível agora (já tocadas, intervalo de 7 dias ou fora das regras)";
    } else if (mode === "ACTIVE") {
      label = `${titles.length} faixa(s) entraram como candidatas`;
    } else {
      label = `${titles.length} faixa(s) entrariam — em teste, ainda fora da playlist`;
    }
    reviews.set(targetId, { mode, label, titles });
  }
  return reviews;
}
