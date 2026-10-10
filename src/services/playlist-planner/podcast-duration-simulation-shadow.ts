import { playlistOrderHash } from "@/services/playlist-ordering";
import {
  DEFAULT_PODCAST_DURATION_BAND_LIMITS,
  type PodcastDurationBand,
  type PodcastDurationBandLimits,
} from "./podcast-duration-bands";
import { comparePodcastDurationShadow } from "./podcast-duration-shadow";
import type { PlanPlaylistInput } from "./planner";
import type { PlanRunResult } from "./plan-run";

export type Podcast08CapturedContext = Readonly<{
  input: PlanPlaylistInput;
  /** Result from the exact legacy single-block planner seam. */
  actualUris: readonly string[];
}>;

export type Podcast08SimulationTargetEvidence = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  status: string;
  reason: string | null;
  requestedBands: readonly PodcastDurationBand[];
  actualCount: number | null;
  projectedCount: number | null;
  actualOrderHash: string | null;
  projectedOrderHash: string | null;
  differentPositions: number | null;
  fallbackCount: number;
  sampledSlots: readonly {
    patternIndex: number;
    position: number;
    requestedBand: PodcastDurationBand;
    fallbackStepBand: PodcastDurationBand | null;
    fallbackApplied: boolean;
    reason: string;
  }[];
}>;

export type Podcast08SimulationEvidence = Readonly<{
  gate: 4;
  mode: "SHADOW";
  plannerInfluence: false;
  spotifyWrites: false;
  providerReadsAdded: false;
  extraConfigurationDatabaseReads: number;
  scope: "FINAL_INCREMENTAL_SINGLE_BLOCK_PRE_POSTPROCESS";
  targetCount: number;
  targets: readonly Podcast08SimulationTargetEvidence[];
}>;

/**
 * Runs once after incremental collection, over precisely the canonical
 * source-scoped, reserved, cadence-filtered contexts captured in planRun.
 * No planning during source pagination; no provider reads/writes.
 *
 * This does NOT model changed reservations between targets, post-processing
 * MUSIC-06 ordering, or multiple CALENDAR-03 blocks; all outputs are
 * illustrative and never applied to an authoritative playlist.
 */
export function evaluatePodcast08FinalSimulationShadow(input: {
  finalPlan: PlanRunResult;
  contexts: ReadonlyMap<string, Podcast08CapturedContext>;
  bandsByTargetId: ReadonlyMap<string, readonly PodcastDurationBand[]>;
  limits?: PodcastDurationBandLimits;
  extraConfigurationDatabaseReads?: number;
}): Podcast08SimulationEvidence {
  const targets: Podcast08SimulationTargetEvidence[] = [];
  const finalTargets = new Map(
    input.finalPlan.targets.map((target) => [target.targetPlaylistId, target] as const),
  );
  for (const [targetId, bands] of input.bandsByTargetId) {
    const planned = finalTargets.get(targetId);
    const ctx = input.contexts.get(targetId);
    const neutral = {
      targetPlaylistId: targetId,
      targetName: planned?.name ?? targetId,
      requestedBands: [...bands],
      actualCount: planned?.result.items.length ?? null,
      projectedCount: null,
      actualOrderHash: planned ? playlistOrderHash(planned.result.items) : null,
      projectedOrderHash: null,
      differentPositions: null,
      fallbackCount: 0,
      sampledSlots: [],
    } as const;

    if (!planned || !ctx) {
      targets.push({
        ...neutral,
        status: "ABSTAIN_NO_SINGLE_BLOCK_CONTEXT",
        reason: "SEGMENTED_OR_NOT_PLANNED",
      });
      continue;
    }

    const finalUris = planned.result.items.map((item) => item.uri);
    if (
      finalUris.length !== ctx.actualUris.length ||
      finalUris.some((uri, index) => uri !== ctx.actualUris[index])
    ) {
      targets.push({
        ...neutral,
        status: "ABSTAIN_NON_CANONICAL_BASELINE",
        reason: "UPSTREAM_OR_RESERVE_POSTPROCESS_CHANGED_SELECTION",
      });
      continue;
    }
    try {
      const { actual, evidence } = comparePodcastDurationShadow(
        ctx.input,
        bands,
        input.limits ?? DEFAULT_PODCAST_DURATION_BAND_LIMITS,
      );
      const replayUris = actual.items.map((item) => item.uri);
      if (
        replayUris.length !== finalUris.length ||
        replayUris.some((uri, index) => uri !== finalUris[index])
      ) {
        targets.push({
          ...neutral,
          status: "ABSTAIN_NON_CANONICAL_BASELINE",
          reason: "CONTEXT_REPLAY_NOT_EQUAL_TO_AUTHORITATIVE_PLAN",
        });
        continue;
      }
      targets.push({
        ...neutral,
        status: evidence.status,
        reason: evidence.reason,
        projectedCount: evidence.projectedItemCount,
        projectedOrderHash: evidence.projectedOrderHash,
        differentPositions: evidence.differentPositions,
        fallbackCount: evidence.fallbackCount,
        sampledSlots: evidence.slots.slice(0, 40).map((slot) => ({
          patternIndex: slot.patternIndex,
          position: slot.position,
          requestedBand: slot.requestedBand,
          fallbackStepBand: slot.fallbackStepBand,
          fallbackApplied: slot.fallbackApplied,
          reason: slot.reason,
        })),
      });
    } catch {
      targets.push({
        ...neutral,
        status: "ABSTAIN_SHADOW_EVALUATION_ERROR",
        reason: "PURE_SHADOW_EXCEPTION",
      });
    }
  }
  return {
    gate: 4,
    mode: "SHADOW",
    plannerInfluence: false,
    spotifyWrites: false,
    providerReadsAdded: false,
    extraConfigurationDatabaseReads: input.extraConfigurationDatabaseReads ?? 0,
    scope: "FINAL_INCREMENTAL_SINGLE_BLOCK_PRE_POSTPROCESS",
    targetCount: targets.length,
    targets,
  };
}
