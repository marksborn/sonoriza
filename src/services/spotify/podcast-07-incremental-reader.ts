import type { User } from "@prisma/client";

import type { IncrementalSourceBatch } from "@/jobs/incremental-planning";

import {
  SpotifyIncrementalReader as BaseSpotifyIncrementalReader,
  type IncrementalSpotifySourceConfig,
  type SpotifyIncrementalCandidateSource,
} from "./incremental-reader";
import {
  applyPodcast07SavedEpisodesCandidates,
  currentPodcast07RuntimeState,
  recordPodcast07ProviderReads,
  type Podcast07ShowOverrideRuntime,
  type Podcast07SourceDescriptor,
} from "./podcast-07-runtime";
import { applyPodcastShowPolicy } from "./podcast-show-policy";
import {
  hydratePodcastShowPolicyHistory,
  type PodcastShowPolicyRuntimeSnapshot,
} from "./podcast-show-policy-history";
import { loadPodcastShowPolicies } from "./podcast-show-policy-store";

export type {
  IncrementalSpotifySourceConfig,
  SpotifyIncrementalCandidateSource,
} from "./incremental-reader";

type SavedUniverse = {
  candidates: SpotifyCandidate[];
  diagnostics: Omit<IncrementalSourceBatch, "candidates" | "done">;
};

type SpotifyCandidate = IncrementalSourceBatch["candidates"][number];

/**
 * Gate 7 adapter for the existing read-only Spotify incremental reader.
 *
 * OFF/SHADOW preserve the legacy provider topology. Allowlisted ACTIVE mode
 * memoizes one /me/episodes traversal, lets SAVED_ONLY SHOW cursors reuse that
 * set, and leaves only ALL_EPISODES overrides on /shows/:id/episodes.
 */
export class SpotifyIncrementalReader {
  private savedUniverse: Promise<SavedUniverse> | null = null;
  private readonly activeOverrideByShowId: ReadonlyMap<
    string,
    Podcast07ShowOverrideRuntime
  >;
  private readonly genericSuppressedShowIds: ReadonlySet<string>;

  private constructor(
    private readonly userId: string,
    private readonly base: BaseSpotifyIncrementalReader,
    private readonly showPolicies: ReadonlyMap<
      string,
      PodcastShowPolicyRuntimeSnapshot
    >,
    private readonly legacyAuthoritativeShowIds: ReadonlySet<string>,
  ) {
    const state = currentPodcast07RuntimeState();
    const activeOverrides = state
      ? [...state.overridesByShowId.entries()].filter(([showId]) =>
          legacyAuthoritativeShowIds.has(showId),
        )
      : [];
    this.activeOverrideByShowId = new Map(activeOverrides);
    this.genericSuppressedShowIds = new Set(
      state?.effectiveMode === "ACTIVE"
        ? activeOverrides.map(([showId]) => showId)
        : legacyAuthoritativeShowIds,
    );

    if (state) {
      state.activeOverridesByShowId = new Map(activeOverrides);
      const savedOnlyCount = activeOverrides.filter(
        ([, entry]) => entry.showEpisodeScope === "SAVED_ONLY",
      ).length;
      const allEpisodesCount = activeOverrides.length - savedOnlyCount;
      state.evidence.activeShowOverrideCount = activeOverrides.length;
      state.evidence.savedOnlyOverrideCount = savedOnlyCount;
      state.evidence.allEpisodesOverrideCount = allEpisodesCount;
      state.evidence.sourceTopology.projectedSkippedSavedOnlyCatalogCount =
        savedOnlyCount;
      state.evidence.sourceTopology.actualSkippedSavedOnlyCatalogCount =
        state.effectiveMode === "ACTIVE" ? savedOnlyCount : 0;
      state.evidence.sourceTopology.genericSuppressedShowCount =
        this.genericSuppressedShowIds.size;
      state.evidence.collectionInfluence =
        state.effectiveMode === "ACTIVE" &&
        (savedOnlyCount > 0 || state.defaultPolicy?.enabled === true);
      state.evidence.diagnosticCodes = uniqueSorted([
        ...state.evidence.diagnosticCodes,
        ...(state.defaultPolicy?.enabled
          ? ["SAVED_EPISODES_DEFAULT_POLICY_APPLIED"]
          : []),
        ...(savedOnlyCount > 0 ? ["SHOW_SAVED_ONLY_FILTER_APPLIED"] : []),
        ...(allEpisodesCount > 0 ? ["SHOW_ALL_EPISODES_CATALOG_USED"] : []),
        ...(activeOverrides.length > 0
          ? ["GENERIC_SHOW_CANDIDATES_SUPPRESSED_BY_OVERRIDE"]
          : []),
      ]);
    }
  }

  static async forUser(
    userId: string,
    options: { authoritativePodcastProgramIds?: ReadonlySet<string> } = {},
  ): Promise<SpotifyIncrementalReader> {
    // The adapter owns generic SHOW suppression so SAVED_ONLY can reuse the
    // saved pool. The base reader receives an empty suppression set and remains
    // otherwise unchanged.
    const [base, basePolicies] = await Promise.all([
      BaseSpotifyIncrementalReader.forUser(userId, {
        authoritativePodcastProgramIds: new Set(),
      }),
      loadPodcastShowPolicies(userId),
    ]);
    const showPolicies = await hydratePodcastShowPolicyHistory(
      userId,
      basePolicies,
    );
    return new SpotifyIncrementalReader(
      userId,
      base,
      showPolicies,
      options.authoritativePodcastProgramIds ?? new Set(),
    );
  }

  getRequestMetrics() {
    const metrics = this.base.getRequestMetrics();
    const showCatalogPagesByShowId: Record<string, number> = {};
    for (const [key, value] of Object.entries(metrics.sourceReads)) {
      if (!key.startsWith("SHOW:")) continue;
      showCatalogPagesByShowId[key.slice("SHOW:".length)] = value.pagesRead;
    }
    recordPodcast07ProviderReads({
      savedEpisodesPages: metrics.sourceReads.SAVED_EPISODES?.pagesRead ?? 0,
      showCatalogPagesByShowId,
    });
    return metrics;
  }

  async createSource(
    source: IncrementalSpotifySourceConfig,
  ): Promise<SpotifyIncrementalCandidateSource> {
    const state = currentPodcast07RuntimeState();
    const active = state?.effectiveMode === "ACTIVE";

    if (active && source.kind === "PODCAST" && source.spotifyType === "SHOW") {
      const override = this.activeOverrideByShowId.get(source.spotifyId);
      if (override?.showEpisodeScope === "SAVED_ONLY") {
        return this.createSavedOnlyShowSource(source, override);
      }
    }

    if (
      active &&
      source.kind === "PODCAST" &&
      source.spotifyType === "SAVED_EPISODES" &&
      state?.savedSource?.id === source.id &&
      (state.defaultPolicy?.enabled || this.hasActiveSavedOnlyOverride())
    ) {
      state.activeSavedSource = true;
      return this.createResolvedSavedEpisodesSource(source);
    }

    const cursor = await this.base.createSource(source);
    if (source.kind !== "PODCAST" || source.spotifyType === "SHOW") {
      return cursor;
    }
    return this.wrapGenericPodcastSuppression(cursor);
  }

  private createResolvedSavedEpisodesSource(
    source: IncrementalSpotifySourceConfig,
  ): SpotifyIncrementalCandidateSource {
    let done = false;
    return {
      id: source.id,
      label: source.name ?? "Seus episódios",
      kind: "PODCAST",
      spotifyType: "SAVED_EPISODES",
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      readNext: async () => {
        if (done) return { candidates: [], done: true };
        const universe = await this.readSavedUniverse(source);
        done = true;
        const sourceDescriptor = descriptor(source);
        const candidates = applyPodcast07SavedEpisodesCandidates({
          candidates: universe.candidates.map((candidate) => ({
            ...candidate,
            sourcePlaylistId: source.id,
            sourceSpotifyType: "SAVED_EPISODES" as const,
            sourceSpotifyId: source.spotifyId,
          })),
          source: sourceDescriptor,
          showPolicies: this.showPolicies,
        });
        return {
          ...universe.diagnostics,
          candidates,
          done: true,
        };
      },
    };
  }

  private createSavedOnlyShowSource(
    source: IncrementalSpotifySourceConfig,
    override: Podcast07ShowOverrideRuntime,
  ): SpotifyIncrementalCandidateSource {
    let done = false;
    return {
      id: source.id,
      label: source.name ?? "Programa de podcast",
      kind: "PODCAST",
      spotifyType: "SHOW",
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      readNext: async () => {
        if (done) return { candidates: [], done: true };
        const universe = await this.readSavedUniverse();
        done = true;
        const policy = this.showPolicies.get(override.sourcePlaylistId);
        if (!policy) {
          return { candidates: [], done: true };
        }
        const savedOnly = universe.candidates
          .filter((candidate) => candidate.programId === override.spotifyShowId)
          .map((candidate) => ({
            ...candidate,
            sourcePlaylistId: override.sourcePlaylistId,
            sourceSpotifyType: "SHOW" as const,
            sourceSpotifyId: override.spotifyShowId,
          }));
        return {
          candidates: applyPodcastShowPolicy(savedOnly, policy).candidates,
          done: true,
        };
      },
    };
  }

  private wrapGenericPodcastSuppression(
    cursor: SpotifyIncrementalCandidateSource,
  ): SpotifyIncrementalCandidateSource {
    const suppressed = this.genericSuppressedShowIds;
    if (suppressed.size === 0) return cursor;
    return {
      id: cursor.id,
      label: cursor.label,
      kind: cursor.kind,
      spotifyType: cursor.spotifyType,
      spotifyId: cursor.spotifyId,
      get done() {
        return cursor.done;
      },
      readNext: async () => {
        const batch = await cursor.readNext();
        let suppressedCount = 0;
        const candidates = batch.candidates.filter((candidate) => {
          const programId = candidate.programId?.trim();
          if (programId && suppressed.has(programId)) {
            suppressedCount += 1;
            return false;
          }
          return true;
        });
        return {
          ...batch,
          candidates,
          genericPodcastSuppressedCount:
            (batch.genericPodcastSuppressedCount ?? 0) + suppressedCount,
        };
      },
    };
  }

  private async readSavedUniverse(
    realSavedSource?: IncrementalSpotifySourceConfig,
  ): Promise<SavedUniverse> {
    if (!this.savedUniverse) {
      const state = currentPodcast07RuntimeState();
      const configured = realSavedSource ?? state?.savedSource ?? null;
      const synthetic: IncrementalSpotifySourceConfig = configured
        ? {
            id: configured.id,
            userId: this.userId,
            kind: "PODCAST",
            spotifyType: "SAVED_EPISODES",
            spotifyId: configured.spotifyId,
            name: configured.name ?? "Seus episódios",
            includePlayed: true,
            episodeOrder: "SOURCE_DEFAULT",
            spotifySnapshotId: null,
            cachedCandidates: null,
          }
        : {
            id: `podcast07-saved-dependency:${this.userId}`,
            userId: this.userId,
            kind: "PODCAST",
            spotifyType: "SAVED_EPISODES",
            spotifyId: "saved-episodes",
            name: "Seus episódios",
            includePlayed: true,
            episodeOrder: "SOURCE_DEFAULT",
            spotifySnapshotId: null,
            cachedCandidates: null,
          };
      this.savedUniverse = this.readAllSavedPages(synthetic);
      if (state && !realSavedSource && !state.activeSavedSource) {
        state.evidence.sourceTopology.savedDependencyAdded = true;
      }
    }
    return this.savedUniverse;
  }

  private async readAllSavedPages(
    source: IncrementalSpotifySourceConfig,
  ): Promise<SavedUniverse> {
    const cursor = await this.base.createSource(source);
    const candidates: SpotifyCandidate[] = [];
    const diagnostics: Omit<IncrementalSourceBatch, "candidates" | "done"> = {};
    while (!cursor.done) {
      const batch = await cursor.readNext();
      candidates.push(...batch.candidates);
      mergeCount(diagnostics, "playbackPositionMissingCount", batch);
      mergeCount(diagnostics, "fullyPlayedSkippedCount", batch);
      mergeCount(diagnostics, "podcastNotStartedCount", batch);
      mergeCount(diagnostics, "podcastInProgressCount", batch);
      mergeCount(diagnostics, "podcastCompletedCount", batch);
    }
    return { candidates, diagnostics };
  }

  private hasActiveSavedOnlyOverride(): boolean {
    return [...this.activeOverrideByShowId.values()].some(
      (entry) => entry.showEpisodeScope === "SAVED_ONLY",
    );
  }
}

function descriptor(source: IncrementalSpotifySourceConfig): Podcast07SourceDescriptor {
  return {
    id: source.id,
    kind: source.kind,
    spotifyType: source.spotifyType,
    spotifyId: source.spotifyId,
    name: source.name,
    enabled: true,
    includePlayed: source.includePlayed,
  };
}

function mergeCount(
  target: Omit<IncrementalSourceBatch, "candidates" | "done">,
  key:
    | "playbackPositionMissingCount"
    | "fullyPlayedSkippedCount"
    | "podcastNotStartedCount"
    | "podcastInProgressCount"
    | "podcastCompletedCount",
  source: IncrementalSourceBatch,
): void {
  target[key] = (target[key] ?? 0) + (source[key] ?? 0);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
