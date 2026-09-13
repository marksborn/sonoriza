import {
  resolvePodcastEffectivePolicyShadow,
  type PodcastEffectivePolicyShadowResult,
  type PodcastSavedEpisodeShadowObservation,
  type PodcastShowOverrideShadow,
} from "./podcast-effective-policy-shadow";
import type { PodcastSavedEpisodesPolicySnapshot } from "./podcast-saved-episodes-policy-store";
import type { PodcastShowEpisodeScopeValue } from "./podcast-show-policy-store";

export type Podcast07PoolShadowPage = Readonly<{
  episodes: readonly PodcastSavedEpisodeShadowObservation[];
  nextCursor: string | null;
}>;

/**
 * Provider seam for PODCAST-07 Gate 3.
 *
 * The production Spotify reader is deliberately not wired here yet. Gate 3
 * proves the provider-read topology and resolved pool in shadow only; Gate 7
 * owns productive planner influence.
 */
export type Podcast07PoolShadowProvider = Readonly<{
  readSavedEpisodesPage: (
    cursor: string | null,
  ) => Promise<Podcast07PoolShadowPage>;
  readShowEpisodesPage: (
    spotifyShowId: string,
    cursor: string | null,
  ) => Promise<Podcast07PoolShadowPage>;
}>;

export type Podcast07PoolShadowAuthority =
  | "SHOW_OVERRIDE"
  | "SAVED_EPISODES_DEFAULT"
  | "LEGACY_SAVED_EPISODES";

export type Podcast07PoolShadowOrigin = "SAVED_EPISODES" | "SHOW_CATALOG";

export type Podcast07PoolShadowCandidate =
  PodcastSavedEpisodeShadowObservation &
    Readonly<{
      authority: Podcast07PoolShadowAuthority;
      sourcePlaylistId: string;
      showEpisodeScope: PodcastShowEpisodeScopeValue | null;
      origin: Podcast07PoolShadowOrigin;
    }>;

export type Podcast07PoolShadowDiagnostics = Readonly<{
  savedEpisodesTraversalCount: 1;
  savedEpisodesCallCount: number;
  savedEpisodesPageCount: number;
  savedEpisodesFetchedCount: number;
  observedShowCount: number;
  defaultGovernedShowCount: number;
  legacySavedEpisodesShowCount: number;
  showOverrideObservedShowCount: number;
  savedOnlyOverrideShowCount: number;
  allEpisodesOverrideShowCount: number;
  savedOnlyReusedCandidateCount: number;
  showCatalogCallCount: number;
  showCatalogPageCount: number;
  showCatalogFetchedCount: number;
  showCatalogCallsByShowId: Readonly<Record<string, number>>;
  catalogShowMismatchCount: number;
  precedenceSuppressedSavedEpisodeCount: number;
  deduplicatedCandidateCount: number;
  resolvedCandidateCount: number;
}>;

export type Podcast07EfficientPoolShadowResult = Readonly<{
  policyResolution: PodcastEffectivePolicyShadowResult;
  candidates: readonly Podcast07PoolShadowCandidate[];
  diagnostics: Podcast07PoolShadowDiagnostics;
}>;

/**
 * PODCAST-07 Gate 3 efficient pool projection.
 *
 * Invariants proved here before productive activation:
 * - SAVED_EPISODES is traversed exactly once, regardless of how many SAVED_ONLY
 *   overrides exist;
 * - SAVED_ONLY reuses that already collected pool and never reads show catalog;
 * - only explicit ALL_EPISODES overrides may read /shows/:id/episodes;
 * - SHOW authority replaces the generic SAVED_EPISODES authority for the same
 *   show before canonical dedupe;
 * - no planner input, policy row or Spotify write is changed by this function.
 */
export async function collectPodcast07EfficientPoolShadow(input: {
  savedEpisodesSourcePlaylistId: string;
  defaultPolicy: PodcastSavedEpisodesPolicySnapshot | null;
  showOverrides: readonly PodcastShowOverrideShadow[];
  provider: Podcast07PoolShadowProvider;
}): Promise<Podcast07EfficientPoolShadowResult> {
  const savedRead = await readAllPages((cursor) =>
    input.provider.readSavedEpisodesPage(cursor),
  );
  const savedEpisodes = savedRead.episodes;

  const policyResolution = resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: input.savedEpisodesSourcePlaylistId,
    defaultPolicy: input.defaultPolicy,
    showOverrides: input.showOverrides,
    savedEpisodes,
  });

  const overrideByShowId = canonicalOverrideMap(input.showOverrides);
  const staged: Podcast07PoolShadowCandidate[] = [];
  let savedOnlyReusedCandidateCount = 0;

  for (const group of policyResolution.groups) {
    const effective = group.effectivePolicy;

    if (effective.authority === "SHOW_OVERRIDE") {
      if (effective.showEpisodeScope === "SAVED_ONLY") {
        for (const episode of group.savedEpisodes) {
          staged.push({
            ...episode,
            authority: "SHOW_OVERRIDE",
            sourcePlaylistId: effective.sourcePlaylistId,
            showEpisodeScope: "SAVED_ONLY",
            origin: "SAVED_EPISODES",
          });
          savedOnlyReusedCandidateCount += 1;
        }
      }
      // ALL_EPISODES is supplied only by the explicit SHOW catalog below.
      continue;
    }

    for (const episode of group.savedEpisodes) {
      staged.push({
        ...episode,
        authority: effective.authority,
        sourcePlaylistId: effective.sourcePlaylistId,
        showEpisodeScope: null,
        origin: "SAVED_EPISODES",
      });
    }
  }

  let showCatalogCallCount = 0;
  let showCatalogPageCount = 0;
  let showCatalogFetchedCount = 0;
  let catalogShowMismatchCount = 0;
  const showCatalogCallsByShowId: Record<string, number> = {};

  const canonicalOverrides = [...overrideByShowId.values()].sort((left, right) =>
    left.spotifyShowId.localeCompare(right.spotifyShowId),
  );

  for (const override of canonicalOverrides) {
    if (override.showEpisodeScope !== "ALL_EPISODES") continue;

    const catalogRead = await readAllPages(async (cursor) => {
      showCatalogCallCount += 1;
      showCatalogCallsByShowId[override.spotifyShowId] =
        (showCatalogCallsByShowId[override.spotifyShowId] ?? 0) + 1;
      return input.provider.readShowEpisodesPage(override.spotifyShowId, cursor);
    });
    showCatalogPageCount += catalogRead.pageCount;
    showCatalogFetchedCount += catalogRead.episodes.length;

    for (const episode of catalogRead.episodes) {
      const observedShowId = normalizedId(episode.spotifyShowId);
      if (observedShowId && observedShowId !== override.spotifyShowId) {
        catalogShowMismatchCount += 1;
        continue;
      }

      staged.push({
        ...episode,
        spotifyShowId: override.spotifyShowId,
        authority: "SHOW_OVERRIDE",
        sourcePlaylistId: override.sourcePlaylistId,
        showEpisodeScope: "ALL_EPISODES",
        origin: "SHOW_CATALOG",
      });
    }
  }

  const candidates: Podcast07PoolShadowCandidate[] = [];
  const seen = new Set<string>();
  let deduplicatedCandidateCount = 0;

  for (const candidate of staged) {
    const identity = canonicalEpisodeIdentity(candidate);
    if (seen.has(identity)) {
      deduplicatedCandidateCount += 1;
      continue;
    }
    seen.add(identity);
    candidates.push(candidate);
  }

  const savedOnlyOverrideShowCount = canonicalOverrides.filter(
    (override) => override.showEpisodeScope === "SAVED_ONLY",
  ).length;
  const allEpisodesOverrideShowCount = canonicalOverrides.filter(
    (override) => override.showEpisodeScope === "ALL_EPISODES",
  ).length;

  return {
    policyResolution,
    candidates,
    diagnostics: {
      savedEpisodesTraversalCount: 1,
      savedEpisodesCallCount: savedRead.callCount,
      savedEpisodesPageCount: savedRead.pageCount,
      savedEpisodesFetchedCount: savedEpisodes.length,
      observedShowCount: policyResolution.diagnostics.observedShowCount,
      defaultGovernedShowCount:
        policyResolution.diagnostics.defaultGovernedShowCount,
      legacySavedEpisodesShowCount:
        policyResolution.diagnostics.legacySavedEpisodesShowCount,
      showOverrideObservedShowCount:
        policyResolution.diagnostics.showOverrideCount,
      savedOnlyOverrideShowCount,
      allEpisodesOverrideShowCount,
      savedOnlyReusedCandidateCount,
      showCatalogCallCount,
      showCatalogPageCount,
      showCatalogFetchedCount,
      showCatalogCallsByShowId,
      catalogShowMismatchCount,
      precedenceSuppressedSavedEpisodeCount:
        policyResolution.diagnostics.shadowSuppressedSavedEpisodeCount,
      deduplicatedCandidateCount,
      resolvedCandidateCount: candidates.length,
    },
  };
}

function canonicalOverrideMap(
  overrides: readonly PodcastShowOverrideShadow[],
): Map<string, PodcastShowOverrideShadow> {
  const result = new Map<string, PodcastShowOverrideShadow>();
  for (const override of [...overrides].sort((left, right) =>
    left.sourcePlaylistId.localeCompare(right.sourcePlaylistId),
  )) {
    const spotifyShowId = normalizedId(override.spotifyShowId);
    if (!spotifyShowId) continue;
    result.set(spotifyShowId, { ...override, spotifyShowId });
  }
  return result;
}

async function readAllPages(
  readPage: (cursor: string | null) => Promise<Podcast07PoolShadowPage>,
): Promise<{
  episodes: PodcastSavedEpisodeShadowObservation[];
  callCount: number;
  pageCount: number;
}> {
  const episodes: PodcastSavedEpisodeShadowObservation[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let callCount = 0;
  let pageCount = 0;

  while (true) {
    const page = await readPage(cursor);
    callCount += 1;
    pageCount += 1;
    episodes.push(...page.episodes.map((episode) => ({ ...episode })));

    const nextCursor = normalizedId(page.nextCursor);
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Podcast shadow pagination repeated cursor: ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { episodes, callCount, pageCount };
}

function canonicalEpisodeIdentity(
  episode: PodcastSavedEpisodeShadowObservation,
): string {
  const spotifyEpisodeId = normalizedId(episode.spotifyEpisodeId);
  if (spotifyEpisodeId) return `spotify:episode:${spotifyEpisodeId}`;
  return `uri:${episode.spotifyUri.trim()}`;
}

function normalizedId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
