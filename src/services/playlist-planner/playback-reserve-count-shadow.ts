import { createHash } from "node:crypto";

import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";

import { planPlaylist, type PlannerPools } from "./planner";
import type { Candidate, PlanResult, PlaylistRules } from "./types";
import type { PlaybackReserveShadowSelectedItem } from "./playback-reserve-duration-shadow";

export type PlaybackReserveCountMode = "MUSIC_TRACKS" | "PODCAST_EPISODES";

export type PlaybackReserveCountTargetShadow = Readonly<{
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
    mode: PlaybackReserveCountMode;
    startsAtPosition: number;
    requestedCount: number;
    plannedCount: number;
    shortfallCount: number;
    plannedDurationMs: number;
    itemCount: number;
    musicCount: number;
    podcastCount: number;
    fallbackApplied: false;
    selectedItems: readonly PlaybackReserveShadowSelectedItem[];
  }>;
}>;

export type ProjectCountReserveShadowInput = Readonly<{
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
 * PLAYBACK-RESERVE-01 Gate 4.
 *
 * Projects count-based reserve modes after PRIMARY without changing the
 * productive plan or provider collection. MUSIC_TRACKS reuses the canonical
 * music planner one item at a time so diversity is seeded by PRIMARY. Podcast
 * candidates arrive already ordered/filtered by the canonical PODCAST-07 and
 * PODCAST-06 runtime seams; this layer only enforces target caps, duration
 * validity and strict-sequence continuity while selecting up to the requested
 * count. PODCAST_EPISODES never falls back to music.
 */
export function projectCountReserveShadow(
  input: ProjectCountReserveShadowInput,
): PlaybackReserveCountTargetShadow {
  if (
    input.policy.reserveMode !== "MUSIC_TRACKS" &&
    input.policy.reserveMode !== "PODCAST_EPISODES"
  ) {
    throw new Error(
      "Gate 4 count shadow requires MUSIC_TRACKS or PODCAST_EPISODES.",
    );
  }

  const requestedCount =
    input.policy.reserveMode === "MUSIC_TRACKS"
      ? Number(input.policy.musicTrackCount ?? 0)
      : Number(input.policy.podcastEpisodeCount ?? 0);
  if (!Number.isInteger(requestedCount) || requestedCount < 1) {
    throw new Error("Gate 4 count shadow requires a positive requested count.");
  }

  const primaryItems = input.primary.items;
  const reserved = new Set<string>(input.reservedUris ?? []);
  for (const item of primaryItems) reserved.add(item.uri);

  const selected: Candidate[] = [];
  const programCounts = new Map(input.podcastProgramCounts ?? []);

  if (input.policy.reserveMode === "MUSIC_TRACKS") {
    selectMusicTracks({
      requestedCount,
      candidates: input.pools.music,
      primaryItems,
      selected,
      reserved,
      rules: input.rules,
    });
  } else {
    selectPodcastEpisodes({
      requestedCount,
      candidates: input.pools.podcasts,
      selected,
      reserved,
      programCounts,
      rules: input.rules,
    });
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
  const plannedCount = selectedItems.length;
  const shortfallCount = Math.max(0, requestedCount - plannedCount);
  const plannedDurationMs = selectedItems.reduce(
    (sum, item) => sum + item.durationMs,
    0,
  );
  const primaryDeficitMs =
    input.primary.stats.segmentation?.deficitMs ??
    Math.max(0, input.rules.targetDurationMs - input.primary.stats.totalDurationMs);

  return Object.freeze({
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    status: shortfallCount > 0 ? "SHORTFALL" : "READY_SHADOW",
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
      mode: input.policy.reserveMode,
      startsAtPosition: primaryItems.length,
      requestedCount,
      plannedCount,
      shortfallCount,
      plannedDurationMs,
      itemCount: plannedCount,
      musicCount: selectedItems.filter((item) => item.type === "MUSIC").length,
      podcastCount: selectedItems.filter((item) => item.type === "PODCAST").length,
      fallbackApplied: false as const,
      selectedItems: Object.freeze(selectedItems),
    }),
  });
}

function selectMusicTracks(input: {
  requestedCount: number;
  candidates: readonly Candidate[];
  primaryItems: readonly Candidate[];
  selected: Candidate[];
  reserved: Set<string>;
  rules: PlaylistRules;
}): void {
  for (let index = 0; index < input.requestedCount; index += 1) {
    const next = planPlaylist({
      rules: {
        ...input.rules,
        targetDurationMs: 1,
        compositionMode: "PROPORTION",
        podcastPercent: 0,
        sequencePattern: [],
      },
      pools: {
        music: [...input.candidates],
        podcasts: [],
      },
      reserved: input.reserved,
      constraintSeed: [...input.primaryItems, ...input.selected],
    }).items[0];

    if (!next) break;
    input.selected.push(next);
    input.reserved.add(next.uri);
  }
}

function selectPodcastEpisodes(input: {
  requestedCount: number;
  candidates: readonly Candidate[];
  selected: Candidate[];
  reserved: Set<string>;
  programCounts: Map<string, number>;
  rules: PlaylistRules;
}): void {
  const strictBlockedPrograms = new Set<string>();

  for (let index = 0; index < input.requestedCount; index += 1) {
    const next = firstEligiblePodcast({
      candidates: input.candidates,
      reserved: input.reserved,
      programCounts: input.programCounts,
      strictBlockedPrograms,
      rules: input.rules,
    });
    if (!next) break;

    input.selected.push(next);
    input.reserved.add(next.uri);
    if (next.programId) {
      input.programCounts.set(
        next.programId,
        (input.programCounts.get(next.programId) ?? 0) + 1,
      );
    }
  }
}

function firstEligiblePodcast(input: {
  candidates: readonly Candidate[];
  reserved: ReadonlySet<string>;
  programCounts: ReadonlyMap<string, number>;
  strictBlockedPrograms: Set<string>;
  rules: PlaylistRules;
}): Candidate | null {
  for (const candidate of input.candidates) {
    if (candidate.type !== "PODCAST") continue;
    if (input.reserved.has(candidate.uri)) continue;

    const programId = candidate.programId?.trim();
    if (!programId) continue;
    if (input.strictBlockedPrograms.has(programId)) continue;

    const cap = effectivePodcastCap(candidate, input.rules);
    if ((input.programCounts.get(programId) ?? 0) >= cap) continue;

    const durationMs = Math.max(0, candidate.durationMs);
    const maxPodcastDurationMs = input.rules.maxPodcastDurationMs ?? null;
    const validDuration =
      durationMs > 0 &&
      (maxPodcastDurationMs === null || durationMs <= maxPodcastDurationMs);

    if (!validDuration) {
      if (candidate.podcastStrictSequence) {
        input.strictBlockedPrograms.add(programId);
      }
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
