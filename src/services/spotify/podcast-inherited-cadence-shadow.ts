import {
  projectPodcast06PlannerShadow,
  type Podcast06ListeningStateEvidence,
  type Podcast06PlannerShadowEvidence,
} from "@/services/playlist-planner/podcast-cadence-shadow-runtime";
import type { Candidate } from "@/services/playlist-planner/types";

import type { PodcastEffectivePolicyShadowResult } from "./podcast-effective-policy-shadow";
import type { Podcast07PoolShadowCandidate } from "./podcast-efficient-pool-shadow";
import type { PodcastShowCadencePolicySnapshot } from "./podcast-show-cadence-policy-store";

export type Podcast07InheritedCadenceShadowResult = Readonly<{
  policyVersion: "podcast07-gate4-per-show-shadow-v1";
  plannerInfluence: false;
  databaseWrites: false;
  spotifyWrites: false;
  defaultPolicyEnabled: boolean;
  frequencyScope: "PER_SHOW" | "GLOBAL_POOL" | null;
  cadenceConfigured: boolean;
  inheritedPolicyCount: number;
  inheritedShowIds: readonly string[];
  overrideExcludedShowIds: readonly string[];
  projectedBlockedEpisodeIds: readonly string[];
  inProgressContinuationEpisodeIds: readonly string[];
  podcast06: Podcast06PlannerShadowEvidence;
}>;

/**
 * PODCAST-07 Gate 4 shadow projection.
 *
 * A configured SAVED_EPISODES default with PER_SHOW cadence is materialized only
 * in memory as PODCAST-06 show cadence snapshots for shows whose effective
 * authority is SAVED_EPISODES_DEFAULT. Explicit SHOW overrides are excluded,
 * so no duplicate policy row is created and SHOW authority remains intact.
 *
 * The actual cadence/window/IN_PROGRESS semantics are delegated to PODCAST-06.
 * This module is deliberately not wired into productive candidate collection or
 * planner runtime; Gate 7 owns productive influence.
 */
export function projectPodcast07InheritedPerShowCadenceShadow(input: {
  policyResolution: PodcastEffectivePolicyShadowResult;
  candidates: readonly Podcast07PoolShadowCandidate[];
  listeningStates: readonly Podcast06ListeningStateEvidence[];
  timeZone: string | null;
  asOf: Date;
}): Podcast07InheritedCadenceShadowResult {
  const defaultPolicy = input.policyResolution.defaultPolicy;
  const cadenceConfigured =
    defaultPolicy?.cadenceMaxEpisodes !== null &&
    defaultPolicy?.cadenceMaxEpisodes !== undefined &&
    defaultPolicy.cadenceUnit !== null;
  const perShowCadenceEnabled =
    defaultPolicy?.enabled === true &&
    defaultPolicy.frequencyScope === "PER_SHOW" &&
    cadenceConfigured;

  const inheritedGroups = input.policyResolution.groups.filter(
    (group) => group.effectivePolicy.authority === "SAVED_EPISODES_DEFAULT",
  );
  const inheritedPolicies = new Map<string, PodcastShowCadencePolicySnapshot>();

  if (perShowCadenceEnabled && defaultPolicy) {
    for (const group of inheritedGroups) {
      inheritedPolicies.set(group.spotifyShowId, {
        spotifyShowId: group.spotifyShowId,
        showName: group.showName,
        cadenceMaxEpisodes: defaultPolicy.cadenceMaxEpisodes,
        cadenceUnit: defaultPolicy.cadenceUnit,
        priority: "NORMAL",
      });
    }
  }

  const candidateStates = candidateListeningStateMap(input.listeningStates);
  const plannerCandidates = input.candidates.map((candidate) =>
    toPlannerCandidate(candidate, candidateStates),
  );

  const podcast06 = projectPodcast06PlannerShadow({
    policies: inheritedPolicies,
    listeningStates: input.listeningStates,
    timeZone: input.timeZone,
    asOf: input.asOf,
    candidates: plannerCandidates,
  });

  const overrideExcludedShowIds = [
    ...new Set(
      input.candidates.flatMap((candidate) =>
        candidate.authority === "SHOW_OVERRIDE" && candidate.spotifyShowId
          ? [candidate.spotifyShowId]
          : [],
      ),
    ),
  ].sort();

  return {
    policyVersion: "podcast07-gate4-per-show-shadow-v1",
    plannerInfluence: false,
    databaseWrites: false,
    spotifyWrites: false,
    defaultPolicyEnabled: defaultPolicy?.enabled === true,
    frequencyScope: defaultPolicy?.frequencyScope ?? null,
    cadenceConfigured,
    inheritedPolicyCount: inheritedPolicies.size,
    inheritedShowIds: [...inheritedPolicies.keys()].sort(),
    overrideExcludedShowIds,
    projectedBlockedEpisodeIds: podcast06.shows
      .flatMap((show) => show.projectedBlockedEpisodeIds)
      .sort(),
    inProgressContinuationEpisodeIds: podcast06.shows
      .flatMap((show) => show.inProgressContinuationEpisodeIds)
      .sort(),
    podcast06,
  };
}

function candidateListeningStateMap(
  listeningStates: readonly Podcast06ListeningStateEvidence[],
): ReadonlyMap<string, Podcast06ListeningStateEvidence> {
  const result = new Map<string, Podcast06ListeningStateEvidence>();
  for (const state of listeningStates) {
    const existing = result.get(state.spotifyEpisodeId);
    if (!existing || listeningStatusRank(state.status) > listeningStatusRank(existing.status)) {
      result.set(state.spotifyEpisodeId, state);
    }
  }
  return result;
}

function listeningStatusRank(
  status: Podcast06ListeningStateEvidence["status"],
): number {
  switch (status) {
    case "IN_PROGRESS":
      return 3;
    case "COMPLETED":
      return 2;
    case "NOT_STARTED":
      return 1;
  }
}

function toPlannerCandidate(
  candidate: Podcast07PoolShadowCandidate,
  listeningStates: ReadonlyMap<string, Podcast06ListeningStateEvidence>,
): Candidate {
  const spotifyEpisodeId = normalizedId(candidate.spotifyEpisodeId);
  const listeningState = spotifyEpisodeId
    ? listeningStates.get(spotifyEpisodeId)
    : undefined;

  return {
    uri: candidate.spotifyUri,
    type: "PODCAST",
    title: spotifyEpisodeId ?? candidate.spotifyUri,
    programId: normalizedId(candidate.spotifyShowId) ?? undefined,
    spotifyEpisodeId: spotifyEpisodeId ?? undefined,
    podcastListeningStatus: listeningState?.status ?? "NOT_STARTED",
    podcastFirstProgressObservedAt:
      listeningState?.firstProgressObservedAt ?? null,
    sourcePlaylistId: candidate.sourcePlaylistId,
    sourceSpotifyType:
      candidate.origin === "SHOW_CATALOG" ? "SHOW" : "SAVED_EPISODES",
    durationMs: 1,
  };
}

function normalizedId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
