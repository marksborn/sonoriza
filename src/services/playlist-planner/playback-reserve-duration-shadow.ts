import { createHash } from "node:crypto";

import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";

import { planPlaylist, type PlannerPools } from "./planner";
import { selectFittingPodcastsInCanonicalOrder } from "./podcast-fit";
import type { Candidate, PlanResult, PlaylistRules } from "./types";

export type PlaybackReserveShadowSelectedItem = Readonly<{
  position: number;
  role: "RESERVE";
  uri: string;
  type: Candidate["type"];
  durationMs: number;
  spotifyTrackId: string | null;
  spotifyEpisodeId: string | null;
  programId: string | null;
}>;

export type PlaybackReserveDurationTargetShadow = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  status: "READY_SHADOW" | "SHORTFALL";
  plannerInfluence: false;
  spotifyWriteInfluence: false;
  additionalProviderReads: false;
  candidateCoverage: "PRIMARY_COLLECTION_ONLY";
  policy: EffectivePlaybackReservePolicySnapshot;
  primary: Readonly<{
    itemCount: number;
    totalDurationMs: number;
    deficitMs: number;
    compositionQualityPassed: boolean;
    orderHash: string;
    segmentationBlockCount: number;
  }>;
  reserve: Readonly<{
    startsAtPosition: number;
    requestedDurationMs: number;
    plannedDurationMs: number;
    deficitMs: number;
    overfillMs: number;
    itemCount: number;
    musicCount: number;
    podcastCount: number;
    podcastDecision:
      | "DISABLED"
      | "RESERVE_PODCAST_SELECTED"
      | "RESERVE_PODCAST_NO_FITTING_CANDIDATE";
    musicFillApplied: boolean;
    selectedItems: readonly PlaybackReserveShadowSelectedItem[];
  }>;
}>;

export type ProjectDurationReserveShadowInput = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  policy: EffectivePlaybackReservePolicySnapshot;
  primary: PlanResult;
  rules: PlaylistRules;
  pools: PlannerPools;
  reservedUris?: Iterable<string>;
  podcastProgramCounts?: ReadonlyMap<string, number>;
}>;

/**
 * PLAYBACK-RESERVE-01 Gate 5.
 *
 * Projects a DURATION reserve after an already-certified PRIMARY plan. Podcast
 * IF_FITS delegates to the same canonical whole-episode fit selector used by
 * CALENDAR-03: candidate order remains authoritative, duration is only a fit
 * filter, and Candidate.durationMs is the effective listening duration (for an
 * IN_PROGRESS episode, the remaining duration supplied by ingestion/runtime).
 *
 * The projection remains deliberately pure: it never mutates PRIMARY, never
 * writes to Spotify and never asks the provider for more candidates. It can
 * only consume the candidate pool that PRIMARY collection already made
 * available.
 */
export function projectDurationReserveShadow(
  input: ProjectDurationReserveShadowInput,
): PlaybackReserveDurationTargetShadow {
  if (input.policy.reserveMode !== "DURATION") {
    throw new Error("Gate 5 duration shadow requires reserveMode DURATION.");
  }

  const requestedDurationMs = Math.max(
    0,
    Number(input.policy.durationSeconds ?? 0) * 1000,
  );
  if (requestedDurationMs <= 0) {
    throw new Error("Gate 5 duration shadow requires a positive duration budget.");
  }

  const primaryItems = input.primary.items;
  const reserved = new Set<string>(input.reservedUris ?? []);
  for (const item of primaryItems) reserved.add(item.uri);

  const selected: Candidate[] = [];
  let podcastDurationMs = 0;

  let podcastDecision: PlaybackReserveDurationTargetShadow["reserve"]["podcastDecision"] =
    "DISABLED";

  if (input.policy.podcastInDurationReserve === "IF_FITS") {
    const podcastFit = selectFittingPodcastsInCanonicalOrder({
      candidates: input.pools.podcasts,
      reservedUris: reserved,
      budgetMs: requestedDurationMs,
      maxCount: 1,
      programCounts: input.podcastProgramCounts,
      rules: input.rules,
    });
    const podcast = podcastFit.selected[0] ?? null;

    if (podcast) {
      selected.push(podcast);
      reserved.add(podcast.uri);
      podcastDurationMs = podcastFit.selectedDurationMs;
      podcastDecision = "RESERVE_PODCAST_SELECTED";
    } else {
      podcastDecision = "RESERVE_PODCAST_NO_FITTING_CANDIDATE";
    }
  }

  const musicBudgetMs = Math.max(0, requestedDurationMs - podcastDurationMs);

  if (musicBudgetMs > 0) {
    const musicPlan = planPlaylist({
      rules: {
        ...input.rules,
        targetDurationMs: musicBudgetMs,
        compositionMode: "PROPORTION",
        podcastPercent: 0,
        sequencePattern: [],
      },
      pools: {
        music: input.pools.music,
        podcasts: [],
      },
      reserved,
      constraintSeed: [...primaryItems, ...selected],
    });

    for (const item of musicPlan.items) {
      selected.push(item);
      reserved.add(item.uri);
    }
  }

  const selectedItems = selected.map((item, index) => ({
    position: primaryItems.length + index,
    role: "RESERVE" as const,
    uri: item.uri,
    type: item.type,
    durationMs: Math.max(0, item.durationMs),
    spotifyTrackId: item.spotifyTrackId ?? null,
    spotifyEpisodeId: item.spotifyEpisodeId ?? null,
    programId: item.programId ?? null,
  }));
  const plannedDurationMs = selectedItems.reduce(
    (sum, item) => sum + item.durationMs,
    0,
  );
  const deficitMs = Math.max(0, requestedDurationMs - plannedDurationMs);
  const overfillMs = Math.max(0, plannedDurationMs - requestedDurationMs);
  const primaryDeficitMs =
    input.primary.stats.segmentation?.deficitMs ??
    Math.max(0, input.rules.targetDurationMs - input.primary.stats.totalDurationMs);

  return Object.freeze({
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    status: deficitMs > 0 ? "SHORTFALL" : "READY_SHADOW",
    plannerInfluence: false,
    spotifyWriteInfluence: false,
    additionalProviderReads: false,
    candidateCoverage: "PRIMARY_COLLECTION_ONLY",
    policy: input.policy,
    primary: Object.freeze({
      itemCount: primaryItems.length,
      totalDurationMs: input.primary.stats.totalDurationMs,
      deficitMs: primaryDeficitMs,
      compositionQualityPassed: input.primary.stats.compositionQualityPassed,
      orderHash: primaryOrderHash(primaryItems),
      segmentationBlockCount: input.primary.stats.segmentation?.blocks.length ?? 0,
    }),
    reserve: Object.freeze({
      startsAtPosition: primaryItems.length,
      requestedDurationMs,
      plannedDurationMs,
      deficitMs,
      overfillMs,
      itemCount: selectedItems.length,
      musicCount: selectedItems.filter((item) => item.type === "MUSIC").length,
      podcastCount: selectedItems.filter((item) => item.type === "PODCAST").length,
      podcastDecision,
      musicFillApplied: selectedItems.some((item) => item.type === "MUSIC"),
      selectedItems: Object.freeze(selectedItems),
    }),
  });
}

function primaryOrderHash(items: readonly Candidate[]): string {
  const payload = items.map((item, index) => ({
    position: "position" in item ? item.position : index,
    uri: item.uri,
    type: item.type,
    durationMs: item.durationMs,
    planningBlockIndex:
      "planningBlockIndex" in item ? item.planningBlockIndex ?? null : null,
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
