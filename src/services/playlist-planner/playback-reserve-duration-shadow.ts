import { createHash } from "node:crypto";

import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";

import { planPlaylist, type PlannerPools } from "./planner";
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
 * PLAYBACK-RESERVE-01 Gate 3.
 *
 * Projects a DURATION reserve after an already-certified PRIMARY plan. The
 * projection is deliberately pure: it never mutates PRIMARY, never writes to
 * Spotify and never asks the provider for more candidates. It can only consume
 * the candidate pool that PRIMARY collection already made available.
 */
export function projectDurationReserveShadow(
  input: ProjectDurationReserveShadowInput,
): PlaybackReserveDurationTargetShadow {
  if (input.policy.reserveMode !== "DURATION") {
    throw new Error("Gate 3 duration shadow requires reserveMode DURATION.");
  }

  const requestedDurationMs = Math.max(
    0,
    Number(input.policy.durationSeconds ?? 0) * 1000,
  );
  if (requestedDurationMs <= 0) {
    throw new Error("Gate 3 duration shadow requires a positive duration budget.");
  }

  const primaryItems = input.primary.items;
  const reserved = new Set<string>(input.reservedUris ?? []);
  for (const item of primaryItems) reserved.add(item.uri);

  const programCounts = new Map(input.podcastProgramCounts ?? []);
  const selected: Candidate[] = [];

  let podcastDecision: PlaybackReserveDurationTargetShadow["reserve"]["podcastDecision"] =
    "DISABLED";

  if (input.policy.podcastInDurationReserve === "IF_FITS") {
    const podcast = firstFittingPodcast({
      candidates: input.pools.podcasts,
      reserved,
      budgetMs: requestedDurationMs,
      programCounts,
      rules: input.rules,
    });

    if (podcast) {
      selected.push(podcast);
      reserved.add(podcast.uri);
      if (podcast.programId) {
        programCounts.set(
          podcast.programId,
          (programCounts.get(podcast.programId) ?? 0) + 1,
        );
      }
      podcastDecision = "RESERVE_PODCAST_SELECTED";
    } else {
      podcastDecision = "RESERVE_PODCAST_NO_FITTING_CANDIDATE";
    }
  }

  const podcastDurationMs = selected.reduce(
    (sum, item) => sum + Math.max(0, item.durationMs),
    0,
  );
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

function firstFittingPodcast(input: {
  candidates: readonly Candidate[];
  reserved: ReadonlySet<string>;
  budgetMs: number;
  programCounts: ReadonlyMap<string, number>;
  rules: PlaylistRules;
}): Candidate | null {
  const strictBlockedPrograms = new Set<string>();

  for (const candidate of input.candidates) {
    if (candidate.type !== "PODCAST") continue;
    if (input.reserved.has(candidate.uri)) continue;

    const programId = candidate.programId?.trim();
    if (!programId) continue;
    if (strictBlockedPrograms.has(programId)) continue;

    const cap = effectivePodcastCap(candidate, input.rules);
    if ((input.programCounts.get(programId) ?? 0) >= cap) continue;

    const durationMs = Math.max(0, candidate.durationMs);
    const maxPodcastDurationMs = input.rules.maxPodcastDurationMs ?? null;
    const exceedsConfiguredMax =
      maxPodcastDurationMs !== null && durationMs > maxPodcastDurationMs;
    const fits =
      durationMs > 0 &&
      durationMs <= input.budgetMs &&
      !exceedsConfiguredMax;

    if (!fits) {
      if (candidate.podcastStrictSequence) strictBlockedPrograms.add(programId);
      continue;
    }

    return candidate;
  }

  return null;
}

function effectivePodcastCap(candidate: Candidate, rules: PlaylistRules): number {
  const targetCap = Math.max(1, Math.trunc(rules.maxEpisodesPerProgram || 1));
  const showCap = candidate.podcastMaxEpisodesPerCycle;
  if (!Number.isInteger(showCap) || Number(showCap) < 1) return targetCap;
  return Math.min(targetCap, Number(showCap));
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
