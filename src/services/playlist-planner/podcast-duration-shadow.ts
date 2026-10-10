import { playlistOrderHash } from "@/services/playlist-ordering";
import {
  DEFAULT_PODCAST_DURATION_BAND_LIMITS,
  type PodcastDurationBand,
  type PodcastDurationBandLimits,
} from "./podcast-duration-bands";
import {
  planPlaylist,
  projectPodcastDurationPlan,
  type PlanPlaylistInput,
  type PodcastDurationShadowSlot,
} from "./planner";
import type { PlannedItem, PlanResult } from "./types";

export type Podcast08ShadowEvidence = Readonly<{
  gate: 4;
  mode: "SHADOW";
  status: "READY_SHADOW" | "ABSTAIN_UNSUPPORTED_COMPOSITION" | "ABSTAIN_STRICT_SEQUENCE" | "ABSTAIN_INVALID_CONFIGURATION";
  plannerInfluence: false;
  providerReads: false;
  databaseReads: false;
  spotifyWrites: false;
  scope: "ONE_ALREADY_FILTERED_PLANNING_BLOCK";
  reason: string | null;
  requestedBands: readonly PodcastDurationBand[];
  actualItemCount: number;
  actualPodcastCount: number;
  projectedItemCount: number | null;
  projectedPodcastCount: number | null;
  actualUris: readonly string[];
  projectedUris: readonly string[] | null;
  projectedOrderHash: string | null;
  differentPositions: number | null;
  fallbackCount: number;
  slots: readonly PodcastDurationShadowSlot[];
  actualSelectionUnchanged: true;
}>;

/**
 * Pure PODCAST-08 Gate 4 comparison against the exact existing planner.
 *
 * Caller must supply an already-authorized, target-scoped pool: these inputs
 * are NOT raw provider catalog data. A single invocation models ONE budget or
 * PER_EVENT planning block, not inter-target reservations or a full event day.
 *
 * Deliberately abstains for strict show ordering: a band must not skip over an
 * earlier strict episode to select a later episode from that show. Full
 * stateful/show protections belong in Gate 5, not in this preview.
 *
 * No provider or database access, and the actual PlanResult is never mutated.
 */
export function comparePodcastDurationShadow(
  plannerInput: PlanPlaylistInput,
  requestedBands: readonly PodcastDurationBand[],
  limits: PodcastDurationBandLimits = DEFAULT_PODCAST_DURATION_BAND_LIMITS,
): Readonly<{ actual: PlanResult; evidence: Podcast08ShadowEvidence }> {
  const actual = planPlaylist(plannerInput);
  const prefix: Omit<Podcast08ShadowEvidence, "status" | "reason" | "projectedItemCount" | "projectedPodcastCount" | "projectedUris" | "projectedOrderHash" | "differentPositions" | "fallbackCount" | "slots"> = {
    gate: 4,
    mode: "SHADOW",
    plannerInfluence: false,
    providerReads: false,
    databaseReads: false,
    spotifyWrites: false,
    scope: "ONE_ALREADY_FILTERED_PLANNING_BLOCK",
    requestedBands: [...requestedBands],
    actualItemCount: actual.items.length,
    actualPodcastCount: actual.items.filter((item) => item.type === "PODCAST").length,
    actualUris: actual.items.map((item) => item.uri),
    actualSelectionUnchanged: true,
  };

  const abstain = (
    status: Podcast08ShadowEvidence["status"],
    reason: string,
  ) => ({
    actual,
    evidence: {
      ...prefix,
      status,
      reason,
      projectedItemCount: null,
      projectedPodcastCount: null,
      projectedUris: null,
      projectedOrderHash: null,
      differentPositions: null,
      fallbackCount: 0,
      slots: [],
    },
  }) as const;

  if (plannerInput.rules.compositionMode !== "SEQUENCE") {
    return abstain("ABSTAIN_UNSUPPORTED_COMPOSITION", "PROPORTION_MODE");
  }
  if (
    [...plannerInput.pools.podcasts, ...(plannerInput.preserved ?? [])]
      .some((item) => item.type === "PODCAST" && item.podcastStrictSequence === true)
  ) {
    return abstain("ABSTAIN_STRICT_SEQUENCE", "PODCAST_STRICT_SEQUENCE_REQUIRES_STATEFUL_PROJECTION");
  }

  let projection: ReturnType<typeof projectPodcastDurationPlan>;
  try {
    projection = projectPodcastDurationPlan(plannerInput, requestedBands, limits);
  } catch {
    // Diagnostic mode never weakens productive configuration validation.
    return abstain("ABSTAIN_INVALID_CONFIGURATION", "INVALID_BANDS_OR_GLOBAL_LIMITS");
  }

  const actualUris = actual.items.map((item) => item.uri);
  const projectedUris = projection.result.items.map((item) => item.uri);
  const differentPositions = Array.from(
    { length: Math.max(actualUris.length, projectedUris.length) },
    (_, i) => i,
  ).filter((index) => actualUris[index] !== projectedUris[index]).length;

  return {
    actual,
    evidence: {
      ...prefix,
      status: "READY_SHADOW",
      reason: null,
      projectedItemCount: projection.result.items.length,
      projectedPodcastCount: projection.result.items.filter((item: PlannedItem) =>
        item.type === "PODCAST",
      ).length,
      projectedUris,
      projectedOrderHash: playlistOrderHash(projection.result.items),
      differentPositions,
      fallbackCount: projection.slots.filter((slot) => slot.fallbackApplied).length,
      slots: projection.slots,
    },
  };
}
