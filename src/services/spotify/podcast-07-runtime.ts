import { AsyncLocalStorage } from "node:async_hooks";

import {
  projectPodcast06PlannerShadow,
  type Podcast06ListeningStateEvidence,
} from "@/services/playlist-planner/podcast-cadence-shadow-runtime";
import type { Candidate } from "@/services/playlist-planner/types";

import type { PodcastSavedEpisodesPolicySnapshot } from "./podcast-saved-episodes-policy-store";
import type { PodcastShowCadencePolicySnapshot } from "./podcast-show-cadence-policy-store";
import {
  evaluatePodcastShowCadenceShadow,
  type PodcastCadenceWindow,
} from "./podcast-show-cadence-shadow";
import { applyPodcastShowPolicy } from "./podcast-show-policy";
import type { PodcastShowPolicyRuntimeSnapshot } from "./podcast-show-policy-history";
import type { PodcastShowEpisodeScopeValue } from "./podcast-show-policy-store";

const GLOBAL_POOL_SYNTHETIC_SHOW_ID = "podcast07:global-pool";

export type Podcast07PlannerMode = "OFF" | "SHADOW" | "ACTIVE";
export type Podcast07ActivationReason =
  | "MODE_OFF"
  | "MODE_SHADOW"
  | "ACTIVE_ALLOWED"
  | "ACTIVE_EMAIL_NOT_ALLOWED"
  | "INVALID_MODE";

export type Podcast07RuntimeStatus =
  | "NO_POLICY"
  | "READY"
  | "ABSTAIN_SAVED_SOURCE_UNAVAILABLE"
  | "ABSTAIN_TIMEZONE_UNAVAILABLE"
  | "ABSTAIN_INCOMPLETE_CANDIDATE_PROVENANCE"
  | "ABSTAIN_INCOMPLETE_FACTUAL_PROVENANCE";

export type Podcast07SourceDescriptor = Readonly<{
  id: string;
  kind: string;
  spotifyType: string;
  spotifyId: string;
  name?: string | null;
  enabled: boolean;
  includePlayed: boolean;
}>;

export type Podcast07ShowOverrideRuntime = Readonly<{
  sourcePlaylistId: string;
  spotifyShowId: string;
  showEpisodeScope: PodcastShowEpisodeScopeValue;
}>;

export type Podcast07SourceTopology = Readonly<{
  sources: readonly Podcast07SourceDescriptor[];
  authoritativePodcastProgramIds: ReadonlySet<string>;
  genericSuppressedProgramIds: ReadonlySet<string>;
  savedOnlyCursorSourceIds: ReadonlySet<string>;
  savedDependencyAdded: boolean;
  abstained: boolean;
}>;

export type Podcast07RuntimeEvidence = {
  policyVersion: "podcast07-gate7-runtime-v1";
  requestedMode: Podcast07PlannerMode;
  effectiveMode: Podcast07PlannerMode;
  activationReason: Podcast07ActivationReason;
  status: Podcast07RuntimeStatus;
  plannerInfluence: boolean;
  collectionInfluence: boolean;
  databaseWrites: false;
  spotifyWrites: false;
  timeZone: string | null;
  savedEpisodesSourcePlaylistId: string | null;
  defaultPolicyEnabled: boolean;
  frequencyScope: "PER_SHOW" | "GLOBAL_POOL" | null;
  cadenceMaxEpisodes: number | null;
  cadenceUnit: "WEEK" | null;
  showOverrideCount: number;
  activeShowOverrideCount: number;
  savedOnlyOverrideCount: number;
  allEpisodesOverrideCount: number;
  specificCadenceShowIds: string[];
  inheritedCadenceShowIds: string[];
  candidateCount: number;
  defaultCandidateCount: number;
  projectedCandidateCount: number;
  projectedBlockedEpisodeIds: string[];
  inProgressContinuationEpisodeIds: string[];
  projectedEpisodeIds: string[];
  actualEpisodeIds: string[];
  plannedEpisodeIds: string[];
  globalPoolWindow: PodcastCadenceWindow | null;
  globalPoolConsumedCount: number | null;
  globalPoolLimitReached: boolean | null;
  sourceTopology: {
    savedDependencyAdded: boolean;
    projectedSkippedSavedOnlyCatalogCount: number;
    actualSkippedSavedOnlyCatalogCount: number;
    genericSuppressedShowCount: number;
  };
  providerReads: {
    savedEpisodesPages: number;
    savedEpisodesCalls: number;
    showCatalogPages: number;
    showCatalogCalls: number;
    showCatalogPagesByShowId: Record<string, number>;
  };
  diagnosticCodes: string[];
};

export type Podcast07RuntimeState = {
  requestedMode: Podcast07PlannerMode;
  effectiveMode: Podcast07PlannerMode;
  activationReason: Podcast07ActivationReason;
  timeZone: string | null;
  savedSource: Podcast07SourceDescriptor | null;
  defaultPolicy: PodcastSavedEpisodesPolicySnapshot | null;
  overridesBySourceId: ReadonlyMap<string, Podcast07ShowOverrideRuntime>;
  overridesByShowId: ReadonlyMap<string, Podcast07ShowOverrideRuntime>;
  specificCadencePolicies: ReadonlyMap<string, PodcastShowCadencePolicySnapshot>;
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  defaultPublishedEpisodeIdsByShow: ReadonlyMap<string, readonly string[]>;
  activeOverridesByShowId: Map<string, Podcast07ShowOverrideRuntime>;
  activeSavedSource: boolean;
  collectionAbstained: boolean;
  evidence: Podcast07RuntimeEvidence;
};

const storage = new AsyncLocalStorage<Podcast07RuntimeState>();

export function resolvePodcast07Mode(input: {
  requestedMode?: string | null;
  userEmail?: string | null;
  activeEmailAllowlist?: string | null;
}): {
  requestedMode: Podcast07PlannerMode;
  effectiveMode: Podcast07PlannerMode;
  activationReason: Podcast07ActivationReason;
} {
  const raw = normalizedText(input.requestedMode)?.toUpperCase() ?? "SHADOW";
  if (!["OFF", "SHADOW", "ACTIVE"].includes(raw)) {
    return {
      requestedMode: "OFF",
      effectiveMode: "OFF",
      activationReason: "INVALID_MODE",
    };
  }
  const requestedMode = raw as Podcast07PlannerMode;
  if (requestedMode === "OFF") {
    return { requestedMode, effectiveMode: "OFF", activationReason: "MODE_OFF" };
  }
  if (requestedMode === "SHADOW") {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "MODE_SHADOW",
    };
  }

  const email = normalizedText(input.userEmail)?.toLowerCase() ?? null;
  const allowlist = new Set(
    (input.activeEmailAllowlist ?? "")
      .split(/[,;\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (email && allowlist.has(email)) {
    return {
      requestedMode,
      effectiveMode: "ACTIVE",
      activationReason: "ACTIVE_ALLOWED",
    };
  }
  return {
    requestedMode,
    effectiveMode: "SHADOW",
    activationReason: "ACTIVE_EMAIL_NOT_ALLOWED",
  };
}

export function createPodcast07RuntimeState(input: {
  requestedMode?: string | null;
  userEmail?: string | null;
  activeEmailAllowlist?: string | null;
  timeZone: string | null;
  savedSource: Podcast07SourceDescriptor | null;
  defaultPolicy: PodcastSavedEpisodesPolicySnapshot | null;
  showOverrides: readonly Podcast07ShowOverrideRuntime[];
  specificCadencePolicies: ReadonlyMap<string, PodcastShowCadencePolicySnapshot>;
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  defaultPublishedEpisodeIdsByShow?: ReadonlyMap<string, readonly string[]>;
}): Podcast07RuntimeState {
  const mode = resolvePodcast07Mode(input);
  const overridesBySourceId = new Map(
    input.showOverrides.map((entry) => [entry.sourcePlaylistId, entry] as const),
  );
  const overridesByShowId = new Map(
    input.showOverrides.map((entry) => [entry.spotifyShowId, entry] as const),
  );
  const timeZone = normalizedText(input.timeZone);
  const defaultPolicyEnabled = input.defaultPolicy?.enabled === true;

  return {
    ...mode,
    timeZone,
    savedSource: input.savedSource,
    defaultPolicy: input.defaultPolicy,
    overridesBySourceId,
    overridesByShowId,
    specificCadencePolicies: input.specificCadencePolicies,
    listeningStates: input.listeningStates,
    defaultPublishedEpisodeIdsByShow:
      input.defaultPublishedEpisodeIdsByShow ?? new Map(),
    activeOverridesByShowId: new Map(),
    activeSavedSource: false,
    collectionAbstained: false,
    evidence: {
      policyVersion: "podcast07-gate7-runtime-v1",
      requestedMode: mode.requestedMode,
      effectiveMode: mode.effectiveMode,
      activationReason: mode.activationReason,
      status:
        !defaultPolicyEnabled && input.showOverrides.length === 0
          ? "NO_POLICY"
          : "READY",
      plannerInfluence: false,
      collectionInfluence: false,
      databaseWrites: false,
      spotifyWrites: false,
      timeZone,
      savedEpisodesSourcePlaylistId: input.savedSource?.id ?? null,
      defaultPolicyEnabled,
      frequencyScope: input.defaultPolicy?.frequencyScope ?? null,
      cadenceMaxEpisodes: input.defaultPolicy?.cadenceMaxEpisodes ?? null,
      cadenceUnit: input.defaultPolicy?.cadenceUnit ?? null,
      showOverrideCount: input.showOverrides.length,
      activeShowOverrideCount: 0,
      savedOnlyOverrideCount: 0,
      allEpisodesOverrideCount: 0,
      specificCadenceShowIds: [...input.specificCadencePolicies.entries()]
        .filter(([, policy]) =>
          policy.cadenceMaxEpisodes !== null && policy.cadenceUnit !== null,
        )
        .map(([showId]) => showId)
        .sort(),
      inheritedCadenceShowIds: [],
      candidateCount: 0,
      defaultCandidateCount: 0,
      projectedCandidateCount: 0,
      projectedBlockedEpisodeIds: [],
      inProgressContinuationEpisodeIds: [],
      projectedEpisodeIds: [],
      actualEpisodeIds: [],
      plannedEpisodeIds: [],
      globalPoolWindow: null,
      globalPoolConsumedCount: null,
      globalPoolLimitReached: null,
      sourceTopology: {
        savedDependencyAdded: false,
        projectedSkippedSavedOnlyCatalogCount: 0,
        actualSkippedSavedOnlyCatalogCount: 0,
        genericSuppressedShowCount: 0,
      },
      providerReads: {
        savedEpisodesPages: 0,
        savedEpisodesCalls: 0,
        showCatalogPages: 0,
        showCatalogCalls: 0,
        showCatalogPagesByShowId: {},
      },
      diagnosticCodes: [],
    },
  };
}

export function runWithPodcast07RuntimeState<T>(
  state: Podcast07RuntimeState,
  callback: () => T,
): T {
  return storage.run(state, callback);
}

export function currentPodcast07RuntimeState(): Podcast07RuntimeState | undefined {
  return storage.getStore();
}

export function podcast07RuntimeSummary(
  state: Podcast07RuntimeState,
): Podcast07RuntimeEvidence {
  return state.evidence;
}

/**
 * Resolves Gate 7 provider topology without changing target source scope.
 * SAVED_ONLY SHOWs reuse the one SAVED_EPISODES traversal and therefore lose
 * their own catalog cursor only in allowlisted ACTIVE mode. ALL_EPISODES keeps
 * the explicit SHOW cursor. SHADOW/OFF return the exact legacy topology.
 */
export function resolvePodcast07SourceTopology(input: {
  scopedSources: readonly Podcast07SourceDescriptor[];
  globallyEnabledSources: readonly Podcast07SourceDescriptor[];
}): Podcast07SourceTopology {
  const state = currentPodcast07RuntimeState();
  const legacyShowSources = input.scopedSources.filter(
    (source) => source.kind === "PODCAST" && source.spotifyType === "SHOW",
  );
  const legacyShowIds = new Set(legacyShowSources.map((source) => source.spotifyId));

  if (!state || state.effectiveMode !== "ACTIVE") {
    if (state) {
      const projectedSavedOnly = legacyShowSources.filter(
        (source) => state.overridesBySourceId.get(source.id)?.showEpisodeScope === "SAVED_ONLY",
      ).length;
      state.evidence.sourceTopology.projectedSkippedSavedOnlyCatalogCount =
        projectedSavedOnly;
      state.evidence.sourceTopology.genericSuppressedShowCount = legacyShowIds.size;
    }
    return {
      sources: [...input.scopedSources],
      authoritativePodcastProgramIds: legacyShowIds,
      genericSuppressedProgramIds: legacyShowIds,
      savedOnlyCursorSourceIds: new Set(),
      savedDependencyAdded: false,
      abstained: false,
    };
  }

  const activeOverrides = legacyShowSources.flatMap((source) => {
    const override = state.overridesBySourceId.get(source.id);
    return override ? [override] : [];
  });
  state.activeOverridesByShowId = new Map(
    activeOverrides.map((entry) => [entry.spotifyShowId, entry] as const),
  );

  const savedOnlyOverrides = activeOverrides.filter(
    (entry) => entry.showEpisodeScope === "SAVED_ONLY",
  );
  const allEpisodesOverrides = activeOverrides.filter(
    (entry) => entry.showEpisodeScope === "ALL_EPISODES",
  );
  const savedSource = state.savedSource;
  const savedGloballyEnabled = Boolean(
    savedSource && input.globallyEnabledSources.some((source) => source.id === savedSource.id),
  );

  if (savedOnlyOverrides.length > 0 && !savedGloballyEnabled) {
    state.collectionAbstained = true;
    state.evidence.status = "ABSTAIN_SAVED_SOURCE_UNAVAILABLE";
    state.evidence.diagnosticCodes = uniqueSorted([
      ...state.evidence.diagnosticCodes,
      "PODCAST07_SAVED_ONLY_ABSTAIN_SAVED_SOURCE_UNAVAILABLE",
    ]);
    return {
      sources: [...input.scopedSources],
      authoritativePodcastProgramIds: legacyShowIds,
      genericSuppressedProgramIds: legacyShowIds,
      savedOnlyCursorSourceIds: new Set(),
      savedDependencyAdded: false,
      abstained: true,
    };
  }

  const savedOnlySourceIds = new Set(
    savedOnlyOverrides.map((entry) => entry.sourcePlaylistId),
  );
  const actual = input.scopedSources.filter(
    (source) => !savedOnlySourceIds.has(source.id),
  );
  let savedDependencyAdded = false;
  if (
    savedOnlyOverrides.length > 0 &&
    savedSource &&
    !actual.some((source) => source.id === savedSource.id)
  ) {
    const dependency = input.globallyEnabledSources.find(
      (source) => source.id === savedSource.id,
    );
    if (dependency) {
      actual.push(dependency);
      savedDependencyAdded = true;
    }
  }

  state.activeSavedSource = Boolean(
    savedSource && actual.some((source) => source.id === savedSource.id),
  );
  const authority = new Set(activeOverrides.map((entry) => entry.spotifyShowId));
  const genericSuppressed = new Set(
    allEpisodesOverrides.map((entry) => entry.spotifyShowId),
  );

  state.evidence.activeShowOverrideCount = activeOverrides.length;
  state.evidence.savedOnlyOverrideCount = savedOnlyOverrides.length;
  state.evidence.allEpisodesOverrideCount = allEpisodesOverrides.length;
  state.evidence.collectionInfluence =
    savedOnlyOverrides.length > 0 ||
    Boolean(state.activeSavedSource && state.defaultPolicy?.enabled);
  state.evidence.sourceTopology = {
    savedDependencyAdded,
    projectedSkippedSavedOnlyCatalogCount: savedOnlyOverrides.length,
    actualSkippedSavedOnlyCatalogCount: savedOnlyOverrides.length,
    genericSuppressedShowCount: genericSuppressed.size,
  };
  state.evidence.diagnosticCodes = uniqueSorted([
    ...state.evidence.diagnosticCodes,
    ...(state.defaultPolicy?.enabled
      ? ["SAVED_EPISODES_DEFAULT_POLICY_APPLIED"]
      : []),
    ...(savedOnlyOverrides.length > 0 ? ["SHOW_SAVED_ONLY_FILTER_APPLIED"] : []),
    ...(allEpisodesOverrides.length > 0 ? ["SHOW_ALL_EPISODES_CATALOG_USED"] : []),
    ...(activeOverrides.length > 0
      ? ["GENERIC_SHOW_CANDIDATES_SUPPRESSED_BY_OVERRIDE"]
      : []),
  ]);

  return {
    sources: actual,
    authoritativePodcastProgramIds: authority,
    genericSuppressedProgramIds: genericSuppressed,
    savedOnlyCursorSourceIds: savedOnlySourceIds,
    savedDependencyAdded,
    abstained: false,
  };
}

export function podcast07NeedsFullSavedTraversal(sourcePlaylistId: string): boolean {
  const state = currentPodcast07RuntimeState();
  if (!state || state.effectiveMode !== "ACTIVE" || state.collectionAbstained) {
    return false;
  }
  if (state.savedSource?.id !== sourcePlaylistId || !state.activeSavedSource) {
    return false;
  }
  return Boolean(
    state.defaultPolicy?.enabled ||
      [...state.activeOverridesByShowId.values()].some(
        (entry) => entry.showEpisodeScope === "SAVED_ONLY",
      ),
  );
}

/** Applies effective default/override policy to the single collected saved pool. */
export function applyPodcast07SavedEpisodesCandidates(input: {
  candidates: readonly Candidate[];
  source: Podcast07SourceDescriptor;
  showPolicies: ReadonlyMap<string, PodcastShowPolicyRuntimeSnapshot>;
}): Candidate[] {
  const state = currentPodcast07RuntimeState();
  if (
    !state ||
    state.effectiveMode !== "ACTIVE" ||
    state.collectionAbstained ||
    state.savedSource?.id !== input.source.id
  ) {
    return [...input.candidates];
  }

  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    sourcePlaylistId: candidate.sourcePlaylistId ?? input.source.id,
  }));
  const byShow = new Map<string, Candidate[]>();
  const showOrder: string[] = [];
  const ungrouped: Candidate[] = [];
  for (const candidate of candidates) {
    const showId = normalizedText(candidate.programId);
    if (!showId) {
      ungrouped.push(candidate);
      continue;
    }
    if (!byShow.has(showId)) showOrder.push(showId);
    const group = byShow.get(showId) ?? [];
    group.push(candidate);
    byShow.set(showId, group);
  }

  const resolved = new Map<string, Candidate[]>();
  for (const showId of showOrder) {
    const group = byShow.get(showId) ?? [];
    const override = state.activeOverridesByShowId.get(showId);
    if (override?.showEpisodeScope === "ALL_EPISODES") {
      resolved.set(showId, []);
      continue;
    }
    if (override?.showEpisodeScope === "SAVED_ONLY") {
      const policy = input.showPolicies.get(override.sourcePlaylistId);
      if (!policy) {
        // Fail closed for this show: never reinterpret it as the global default.
        resolved.set(showId, []);
        continue;
      }
      const applied = applyPodcastShowPolicy(group, policy).candidates.map(
        (candidate) => ({
          ...candidate,
          sourcePlaylistId: override.sourcePlaylistId,
          sourceSpotifyType: "SHOW" as const,
          sourceSpotifyId: showId,
        }),
      );
      resolved.set(showId, applied);
      continue;
    }

    const legacyEligible = input.source.includePlayed
      ? group
      : group.filter(
          (candidate) => candidate.podcastListeningStatus !== "COMPLETED",
        );
    if (!state.defaultPolicy?.enabled) {
      resolved.set(showId, legacyEligible);
      continue;
    }
    resolved.set(
      showId,
      applySavedDefaultOrder({
        candidates: legacyEligible,
        showId,
        sourcePlaylistId: input.source.id,
        policy: state.defaultPolicy,
        publishedEpisodeIds:
          state.defaultPublishedEpisodeIdsByShow.get(showId) ?? [],
      }),
    );
  }

  // Preserve inter-show placement from /me/episodes while replacing only the
  // relative order/eligibility inside each show. This avoids turning show id
  // ordering into a new global ranking policy.
  const queues = new Map<string, Candidate[]>(
    [...resolved.entries()].map(
      ([showId, group]): [string, Candidate[]] => [showId, [...group]],
    ),
  );
  const output: Candidate[] = [];
  const emittedUngrouped = new Set<Candidate>();
  for (const candidate of candidates) {
    const showId = normalizedText(candidate.programId);
    if (!showId) {
      if (!emittedUngrouped.has(candidate)) {
        emittedUngrouped.add(candidate);
        if (input.source.includePlayed || candidate.podcastListeningStatus !== "COMPLETED") {
          output.push(candidate);
        }
      }
      continue;
    }
    const queue = queues.get(showId);
    const next = queue?.shift();
    if (next) output.push(next);
  }
  return dedupeByUri(output);
}

export function applyPodcast07PlannerRuntimeToCandidates(
  candidates: readonly Candidate[],
): Candidate[] {
  const state = currentPodcast07RuntimeState();
  if (!state || state.effectiveMode === "OFF" || state.collectionAbstained) {
    return [...candidates];
  }

  const projection = projectPlannerCandidates(state, candidates);
  const influence =
    state.effectiveMode === "ACTIVE" && projection.status === "READY";
  state.evidence = {
    ...state.evidence,
    status: projection.status,
    plannerInfluence: influence,
    candidateCount: candidates.filter((candidate) => candidate.type === "PODCAST").length,
    defaultCandidateCount: projection.defaultCandidateCount,
    projectedCandidateCount: projection.candidates.length,
    projectedBlockedEpisodeIds: projection.blockedEpisodeIds,
    inProgressContinuationEpisodeIds: projection.continuationEpisodeIds,
    inheritedCadenceShowIds: projection.inheritedCadenceShowIds,
    projectedEpisodeIds: episodeIds(projection.candidates),
    actualEpisodeIds: episodeIds(influence ? projection.candidates : candidates),
    globalPoolWindow: projection.globalPoolWindow,
    globalPoolConsumedCount: projection.globalPoolConsumedCount,
    globalPoolLimitReached: projection.globalPoolLimitReached,
    diagnosticCodes: uniqueSorted([
      ...state.evidence.diagnosticCodes,
      ...projection.diagnosticCodes,
    ]),
  };
  return influence ? projection.candidates : [...candidates];
}

export function capturePodcast07PlannedItems(plannedItems: readonly Candidate[]): void {
  const state = currentPodcast07RuntimeState();
  if (!state) return;
  state.evidence.plannedEpisodeIds = episodeIds(plannedItems);
}

export function recordPodcast07ProviderReads(input: {
  savedEpisodesPages: number;
  showCatalogPagesByShowId: Readonly<Record<string, number>>;
}): void {
  const state = currentPodcast07RuntimeState();
  if (!state) return;
  const byShow = { ...input.showCatalogPagesByShowId };
  const showCatalogPages = Object.values(byShow).reduce((sum, value) => sum + value, 0);
  state.evidence.providerReads = {
    savedEpisodesPages: input.savedEpisodesPages,
    savedEpisodesCalls: input.savedEpisodesPages,
    showCatalogPages,
    showCatalogCalls: showCatalogPages,
    showCatalogPagesByShowId: byShow,
  };
}

function projectPlannerCandidates(
  state: Podcast07RuntimeState,
  candidates: readonly Candidate[],
): {
  status: Podcast07RuntimeStatus;
  candidates: Candidate[];
  defaultCandidateCount: number;
  blockedEpisodeIds: string[];
  continuationEpisodeIds: string[];
  inheritedCadenceShowIds: string[];
  globalPoolWindow: PodcastCadenceWindow | null;
  globalPoolConsumedCount: number | null;
  globalPoolLimitReached: boolean | null;
  diagnosticCodes: string[];
} {
  const savedSourceId = state.savedSource?.id ?? null;
  const defaultCandidates = savedSourceId
    ? candidates.filter(
        (candidate) =>
          candidate.type === "PODCAST" && candidate.sourcePlaylistId === savedSourceId,
      )
    : [];
  const policy = state.defaultPolicy;
  const cadenceConfigured = Boolean(
    policy?.enabled &&
      policy.cadenceMaxEpisodes !== null &&
      policy.cadenceUnit !== null,
  );

  if (!policy?.enabled || !cadenceConfigured || defaultCandidates.length === 0) {
    return {
      status: "READY",
      candidates: [...candidates],
      defaultCandidateCount: defaultCandidates.length,
      blockedEpisodeIds: [],
      continuationEpisodeIds: [],
      inheritedCadenceShowIds: [],
      globalPoolWindow: null,
      globalPoolConsumedCount: null,
      globalPoolLimitReached: null,
      diagnosticCodes: [],
    };
  }
  if (!state.timeZone) {
    return abstainProjection("ABSTAIN_TIMEZONE_UNAVAILABLE", candidates, defaultCandidates.length);
  }

  const candidateEpisodeToShow = new Map<string, string>();
  for (const candidate of defaultCandidates) {
    const episodeId = normalizedText(candidate.spotifyEpisodeId);
    const showId = normalizedText(candidate.programId);
    if (!episodeId || !showId) {
      return abstainProjection(
        "ABSTAIN_INCOMPLETE_CANDIDATE_PROVENANCE",
        candidates,
        defaultCandidates.length,
      );
    }
    candidateEpisodeToShow.set(episodeId, showId);
  }

  for (const listeningState of state.listeningStates) {
    if (!listeningState.firstProgressObservedAt) continue;
    const showId =
      normalizedText(listeningState.spotifyShowId) ??
      candidateEpisodeToShow.get(listeningState.spotifyEpisodeId) ??
      null;
    if (!showId) {
      return abstainProjection(
        "ABSTAIN_INCOMPLETE_FACTUAL_PROVENANCE",
        candidates,
        defaultCandidates.length,
      );
    }
  }

  const specificCadenceShows = new Set(
    [...state.specificCadencePolicies.entries()]
      .filter(([, specific]) =>
        specific.cadenceMaxEpisodes !== null && specific.cadenceUnit !== null,
      )
      .map(([showId]) => showId),
  );
  const governedDefaultCandidates = defaultCandidates.filter(
    (candidate) =>
      Boolean(candidate.programId) && !specificCadenceShows.has(candidate.programId!),
  );
  const governedShows = [
    ...new Set(governedDefaultCandidates.flatMap((candidate) =>
      candidate.programId ? [candidate.programId] : [],
    )),
  ].sort();

  if (policy.frequencyScope === "PER_SHOW") {
    const inherited = new Map<string, PodcastShowCadencePolicySnapshot>();
    for (const showId of governedShows) {
      inherited.set(showId, {
        spotifyShowId: showId,
        showName: null,
        cadenceMaxEpisodes: policy.cadenceMaxEpisodes,
        cadenceUnit: policy.cadenceUnit,
        // Priority remains entirely under PODCAST-06. This synthetic value is
        // used only to reuse its cadence evaluator and is never used to rank.
        priority: "NORMAL",
      });
    }
    if (inherited.size === 0) {
      return {
        status: "READY",
        candidates: [...candidates],
        defaultCandidateCount: defaultCandidates.length,
        blockedEpisodeIds: [],
        continuationEpisodeIds: [],
        inheritedCadenceShowIds: [],
        globalPoolWindow: null,
        globalPoolConsumedCount: null,
        globalPoolLimitReached: null,
        diagnosticCodes: ["PODCAST07_SPECIFIC_CADENCE_OVERRIDE_PRESERVED"],
      };
    }
    const projected = projectPodcast06PlannerShadow({
      policies: inherited,
      listeningStates: state.listeningStates,
      timeZone: state.timeZone,
      asOf: new Date(),
      candidates: governedDefaultCandidates,
    });
    if (projected.status !== "READY_SHADOW") {
      const mapped =
        projected.status === "ABSTAIN_TIMEZONE_UNAVAILABLE"
          ? "ABSTAIN_TIMEZONE_UNAVAILABLE"
          : projected.status === "ABSTAIN_INCOMPLETE_CANDIDATE_SHOW_PROVENANCE"
            ? "ABSTAIN_INCOMPLETE_CANDIDATE_PROVENANCE"
            : "ABSTAIN_INCOMPLETE_FACTUAL_PROVENANCE";
      return abstainProjection(mapped, candidates, defaultCandidates.length);
    }
    const blocked = new Set(
      projected.shows.flatMap((show) => show.projectedBlockedEpisodeIds),
    );
    const continuation = projected.shows
      .flatMap((show) => show.inProgressContinuationEpisodeIds)
      .sort();
    const output = candidates.filter(
      (candidate) => !candidate.spotifyEpisodeId || !blocked.has(candidate.spotifyEpisodeId),
    );
    return {
      status: "READY",
      candidates: output,
      defaultCandidateCount: defaultCandidates.length,
      blockedEpisodeIds: [...blocked].sort(),
      continuationEpisodeIds: continuation,
      inheritedCadenceShowIds: governedShows,
      globalPoolWindow: null,
      globalPoolConsumedCount: null,
      globalPoolLimitReached: null,
      diagnosticCodes: [
        ...(blocked.size > 0 ? ["SAVED_EPISODES_PER_SHOW_CADENCE_LIMIT_REACHED"] : []),
        ...(specificCadenceShows.size > 0
          ? ["PODCAST07_SPECIFIC_CADENCE_OVERRIDE_PRESERVED"]
          : []),
      ],
    };
  }

  const governedShowSet = new Set(governedShows);
  const syntheticEvidence: Podcast06ListeningStateEvidence[] = [];
  for (const listeningState of state.listeningStates) {
    const showId =
      normalizedText(listeningState.spotifyShowId) ??
      candidateEpisodeToShow.get(listeningState.spotifyEpisodeId) ??
      null;
    if (!showId || !governedShowSet.has(showId)) continue;
    syntheticEvidence.push({
      ...listeningState,
      spotifyShowId: GLOBAL_POOL_SYNTHETIC_SHOW_ID,
    });
  }
  const evaluation = evaluatePodcastShowCadenceShadow({
    evidence: syntheticEvidence,
    showId: GLOBAL_POOL_SYNTHETIC_SHOW_ID,
    maxEpisodes: policy.cadenceMaxEpisodes!,
    unit: policy.cadenceUnit!,
    timeZone: state.timeZone,
    asOf: new Date(),
  });
  const continuation = governedDefaultCandidates
    .filter((candidate) => candidate.podcastListeningStatus === "IN_PROGRESS")
    .flatMap((candidate) => candidate.spotifyEpisodeId ? [candidate.spotifyEpisodeId] : [])
    .sort();
  const blocked = evaluation.limitReached
    ? governedDefaultCandidates
        .filter((candidate) => candidate.podcastListeningStatus !== "IN_PROGRESS")
        .flatMap((candidate) => candidate.spotifyEpisodeId ? [candidate.spotifyEpisodeId] : [])
        .sort()
    : [];
  const blockedSet = new Set(blocked);
  return {
    status: "READY",
    candidates: candidates.filter(
      (candidate) => !candidate.spotifyEpisodeId || !blockedSet.has(candidate.spotifyEpisodeId),
    ),
    defaultCandidateCount: defaultCandidates.length,
    blockedEpisodeIds: blocked,
    continuationEpisodeIds: continuation,
    inheritedCadenceShowIds: governedShows,
    globalPoolWindow: evaluation.window,
    globalPoolConsumedCount: evaluation.consumedCount,
    globalPoolLimitReached: evaluation.limitReached,
    diagnosticCodes: [
      "GLOBAL_POOL_CURRENT_AUTHORITY_AT_EVALUATION",
      ...(evaluation.limitReached
        ? ["SAVED_EPISODES_GLOBAL_CADENCE_LIMIT_REACHED"]
        : []),
      ...(specificCadenceShows.size > 0
        ? ["PODCAST07_SPECIFIC_CADENCE_OVERRIDE_PRESERVED"]
        : []),
    ],
  };
}

function abstainProjection(
  status: Extract<
    Podcast07RuntimeStatus,
    | "ABSTAIN_TIMEZONE_UNAVAILABLE"
    | "ABSTAIN_INCOMPLETE_CANDIDATE_PROVENANCE"
    | "ABSTAIN_INCOMPLETE_FACTUAL_PROVENANCE"
  >,
  candidates: readonly Candidate[],
  defaultCandidateCount: number,
) {
  return {
    status,
    candidates: [...candidates],
    defaultCandidateCount,
    blockedEpisodeIds: [] as string[],
    continuationEpisodeIds: [] as string[],
    inheritedCadenceShowIds: [] as string[],
    globalPoolWindow: null,
    globalPoolConsumedCount: null,
    globalPoolLimitReached: null,
    diagnosticCodes: [status],
  };
}

function applySavedDefaultOrder(input: {
  candidates: readonly Candidate[];
  showId: string;
  sourcePlaylistId: string;
  policy: PodcastSavedEpisodesPolicySnapshot;
  publishedEpisodeIds: readonly string[];
}): Candidate[] {
  if (input.policy.episodeOrder === "OLDEST_FIRST") {
    return sortByRelease(input.candidates, 1);
  }
  if (input.policy.episodeOrder === "NEWEST_FIRST") {
    return sortByRelease(input.candidates, -1);
  }

  const episodeIds = new Set(
    input.candidates.flatMap((candidate) =>
      candidate.spotifyEpisodeId ? [candidate.spotifyEpisodeId] : [],
    ),
  );
  let round = 0;
  let consumed = new Set<string>();
  if (input.policy.randomPolicy === "WITH_REPLACEMENT") {
    round = input.publishedEpisodeIds.length;
  } else {
    for (const episodeId of input.publishedEpisodeIds) {
      if (!episodeIds.has(episodeId)) continue;
      consumed.add(episodeId);
      if (episodeIds.size > 0 && consumed.size >= episodeIds.size) {
        consumed = new Set();
        round += 1;
      }
    }
  }
  const pool =
    input.policy.randomPolicy === "WITHOUT_REPLACEMENT"
      ? input.candidates.filter(
          (candidate) =>
            !candidate.spotifyEpisodeId || !consumed.has(candidate.spotifyEpisodeId),
        )
      : [...input.candidates];
  return deterministicShuffle(
    pool.length > 0 ? pool : input.candidates,
    `${input.sourcePlaylistId}:${input.showId}:${round}`,
  );
}

function sortByRelease(candidates: readonly Candidate[], direction: 1 | -1): Candidate[] {
  return [...candidates].sort((left, right) => {
    const leftKey = releaseKey(left.releaseDate, left.releaseDatePrecision);
    const rightKey = releaseKey(right.releaseDate, right.releaseDatePrecision);
    if (leftKey === null && rightKey !== null) return 1;
    if (leftKey !== null && rightKey === null) return -1;
    if (leftKey !== null && rightKey !== null && leftKey !== rightKey) {
      return (leftKey < rightKey ? -1 : 1) * direction;
    }
    return left.uri.localeCompare(right.uri);
  });
}

function releaseKey(date: string | undefined, precision: string | undefined): string | null {
  if (!date) return null;
  const parts = date.split("-");
  const year = Number(parts[0]);
  if (!Number.isInteger(year)) return null;
  const month = precision === "year" ? 0 : Number(parts[1] ?? 0);
  const day = precision === "day" ? Number(parts[2] ?? 0) : 0;
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function deterministicShuffle(candidates: readonly Candidate[], seed: string): Candidate[] {
  return [...candidates]
    .map((candidate) => ({
      candidate,
      key: stableHash(`${seed}:${candidate.spotifyEpisodeId ?? candidate.uri}`),
    }))
    .sort((left, right) =>
      left.key - right.key || left.candidate.uri.localeCompare(right.candidate.uri),
    )
    .map((entry) => entry.candidate);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function episodeIds(candidates: readonly Candidate[]): string[] {
  return candidates.flatMap((candidate) =>
    candidate.type === "PODCAST" && candidate.spotifyEpisodeId
      ? [candidate.spotifyEpisodeId]
      : [],
  );
}

function dedupeByUri(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.uri)) return false;
    seen.add(candidate.uri);
    return true;
  });
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
