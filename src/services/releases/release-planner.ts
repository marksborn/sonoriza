import type { Candidate } from "@/services/playlist-planner/types";
import type { TargetDiscoveryIntensity } from "@/services/music-discovery/target-discovery-policy";

import type { ReleaseRadarRelease } from "./release-radar";

/**
 * RELEASES-01 (#161) Gate 2 — the "Novidades" family of Descobrir por destino.
 *
 * Reads only the cached radar (no provider call during generation). Tracks
 * already heard and likely reissues are excluded; each release contributes at
 * most 2 tracks (album) or 1 (single); the number entering a target's music
 * pool is capped by its intensity. Candidates are spread through the pool and
 * still pass the run's cooldown/repeat filters. SHADOW (default) only records
 * what would enter; ACTIVE changes the pool.
 */

export type ReleasesPlannerMode = "OFF" | "SHADOW" | "ACTIVE";

export const RELEASES_PLANNER_POLICY = Object.freeze({
  maxRadarAgeMs: 3 * 86_400_000,
  ceilingByIntensity: { CONSERVATIVE: 2, BALANCED: 4, EXPLORATORY: 6 } as Record<
    TargetDiscoveryIntensity,
    number
  >,
  spreadEvery: 4,
});

export function resolveReleasesPlannerMode(value: string | null | undefined): ReleasesPlannerMode {
  const normalized = value?.trim().toUpperCase();
  return normalized === "OFF" || normalized === "ACTIVE" ? normalized : "SHADOW";
}

const REISSUE_PATTERN =
  /\b(remaster(ed)?|deluxe|anniversary|reissue|expanded|re-?recorded|edi[cç][aã]o especial|special edition|collector'?s edition)\b|\([^)]*\bversion\)\s*$/i;

/** Heuristic: titles that announce an old record re-released. */
export function isLikelyReissue(release: Pick<ReleaseRadarRelease, "name" | "albumType">): boolean {
  return REISSUE_PATTERN.test(release.name);
}

export type ReleaseCandidateSelection = Readonly<{
  candidates: Candidate[];
  reissueExcluded: number;
  heardExcluded: number;
}>;

/** Newest releases first; never more than 2 tracks per album / 1 per single. */
export function releaseCandidatesForPlanner(
  releases: readonly ReleaseRadarRelease[],
): ReleaseCandidateSelection {
  let reissueExcluded = 0;
  let heardExcluded = 0;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const ordered = [...releases].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  for (const release of ordered) {
    if (isLikelyReissue(release)) {
      reissueExcluded += 1;
      continue;
    }
    const perRelease = release.albumType === "single" ? 1 : 2;
    let taken = 0;
    for (const track of release.tracks) {
      if (taken >= perRelease) break;
      if (track.alreadyHeard) {
        heardExcluded += 1;
        continue;
      }
      if (seen.has(track.uri) || track.durationMs <= 0) continue;
      seen.add(track.uri);
      taken += 1;
      candidates.push({
        uri: track.uri,
        type: "MUSIC",
        title: track.name,
        subtitle: release.artists.join(", "),
        spotifyTrackId: track.spotifyTrackId,
        primaryArtistId: release.seedArtistId,
        albumId: release.albumId,
        durationMs: track.durationMs,
      });
    }
  }
  return { candidates, reissueExcluded, heardExcluded };
}

/**
 * Spreads up to `limit` release candidates through the pool: one every
 * `every` positions starting at index 1, skipping URIs already present.
 */
export function spreadReleasesIntoPool(
  pool: readonly Candidate[],
  releases: readonly Candidate[],
  limit: number,
  every = RELEASES_PLANNER_POLICY.spreadEvery,
): { pool: Candidate[]; injected: Candidate[] } {
  const present = new Set(pool.map((candidate) => candidate.uri));
  const injected = releases.filter((candidate) => !present.has(candidate.uri)).slice(0, Math.max(0, limit));
  if (injected.length === 0) return { pool: [...pool], injected };
  const result: Candidate[] = [];
  let next = 0;
  for (let index = 0; index < pool.length; index += 1) {
    if (next < injected.length && index % every === 1) result.push(injected[next++]!);
    result.push(pool[index]!);
  }
  while (next < injected.length) result.push(injected[next++]!);
  return { pool: result, injected };
}

export type ReleasesTargetReview = Readonly<{
  mode: ReleasesPlannerMode;
  label: string;
  titles: string[];
}>;

/** Reads `summary.targetDiscoveryRuntime.evidence.releases` for the review screen. */
export function readReleasesTargetReviews(summary: unknown): ReadonlyMap<string, ReleasesTargetReview> {
  const reviews = new Map<string, ReleasesTargetReview>();
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const entries = record(record(record(summary)?.targetDiscoveryRuntime)?.evidence)?.releases;
  if (!Array.isArray(entries)) return reviews;
  for (const raw of entries) {
    const entry = record(raw);
    const targetId = typeof entry?.targetPlaylistId === "string" ? entry.targetPlaylistId : null;
    if (!entry || !targetId) continue;
    const mode = resolveReleasesPlannerMode(typeof entry.mode === "string" ? entry.mode : null);
    const injected = Array.isArray(entry.injected) ? entry.injected.map(record) : [];
    const titles = injected.flatMap((item) =>
      typeof item?.title === "string"
        ? [typeof item.artists === "string" ? `${item.title} — ${item.artists}` : item.title]
        : [],
    );
    let label: string;
    if (entry.radarFresh !== true) {
      label = "radar desatualizado; atualize em Descobrir → Novidades";
    } else if (titles.length === 0) {
      label = "nenhuma novidade elegível (já ouvidas, reedições ou nenhuma recente)";
    } else if (mode === "ACTIVE") {
      label = `${titles.length} faixa(s) nova(s) entraram como candidatas`;
    } else {
      label = `${titles.length} faixa(s) nova(s) entrariam — em teste, ainda fora da playlist`;
    }
    reviews.set(targetId, { mode, label, titles });
  }
  return reviews;
}
