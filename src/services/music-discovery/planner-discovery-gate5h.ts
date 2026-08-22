import type {
  PlanResult,
  PlanRunResult,
  PlannedItem,
  RunTarget,
} from "@/services/playlist-planner";

import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";
import {
  DISCOVERY_GATE5G_POLICY,
  previewSurgicalDiscoveryRun,
  type Gate5GRunPreview,
} from "./planner-discovery-gate5g";

export const DISCOVERY_GATE5H_POLICY = {
  version: "gate5h-production-runtime-v1",
  discoveryCeiling: DISCOVERY_GATE5G_POLICY.discoveryCeiling,
  musicSpacing: DISCOVERY_GATE5G_POLICY.musicSpacing,
  maxDurationDeltaMs: DISCOVERY_GATE5G_POLICY.maxDurationDeltaMs,
  keepFilledRule: "ABSTAIN_TARGET",
  providerFailureRule: "ABSTAIN_DISCOVERY_KEEP_BASELINE",
  baselineRule: "FINAL_ORDERED_BASELINE_IS_AUTHORITY",
  writeRule: "APPLY_ONLY_WHEN_ALL_SURGICAL_INVARIANTS_PASS",
} as const;

export type DiscoveryGate5HPolicyReason =
  | "BASE_DISCOVERY_DISABLED"
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "ENABLED";

export function resolveDiscoveryGate5HPolicy(input: {
  baseDiscoveryEnabled: boolean;
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
}) {
  if (!input.baseDiscoveryEnabled) {
    return { enabled: false, reason: "BASE_DISCOVERY_DISABLED" as const };
  }
  if (!parseBoolean(input.masterEnabled)) {
    return { enabled: false, reason: "MASTER_DISABLED" as const };
  }
  const email = normalizeEmail(input.userEmail);
  if (!email) {
    return { enabled: false, reason: "USER_EMAIL_MISSING" as const };
  }
  const allowlist = new Set(
    String(input.allowlistedEmails ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value): value is string => Boolean(value)),
  );
  if (!allowlist.has(email)) {
    return { enabled: false, reason: "USER_NOT_ALLOWLISTED" as const };
  }
  return { enabled: true, reason: "ENABLED" as const };
}

export type Gate5HApplyResult = {
  plan: PlanRunResult;
  preview: Gate5GRunPreview | null;
  applied: boolean;
  invariantsPassed: boolean;
  selectedDiscoveryCount: number;
  skippedKeepFilledTargetIds: string[];
};

export function applyDiscoveryGate5H(input: {
  baseline: PlanRunResult;
  targets: RunTarget[];
  discoveries: Gate5FResolvedDiscoveryCandidate[];
  blockedMusicTrackIdsByTargetId?: ReadonlyMap<string, ReadonlySet<string>>;
  keepFilledTargetIds?: ReadonlySet<string>;
}): Gate5HApplyResult {
  const keepFilledTargetIds = input.keepFilledTargetIds ?? new Set<string>();
  const targetById = new Map(
    input.targets.map((target) => [target.targetPlaylistId, target] as const),
  );
  const eligibleBaselineTargets = input.baseline.targets.filter((planned) => {
    if (keepFilledTargetIds.has(planned.targetPlaylistId)) return false;
    if (!targetById.has(planned.targetPlaylistId)) return false;
    return planned.result.items.filter((item) => item.type === "MUSIC").length >=
      DISCOVERY_GATE5H_POLICY.musicSpacing;
  });
  const eligibleTargetIds = new Set(
    eligibleBaselineTargets.map((target) => target.targetPlaylistId),
  );
  const eligibleTargets = input.targets.filter((target) =>
    eligibleTargetIds.has(target.targetPlaylistId),
  );
  const skippedKeepFilledTargetIds = input.baseline.targets
    .filter((target) => keepFilledTargetIds.has(target.targetPlaylistId))
    .map((target) => target.targetPlaylistId);

  if (eligibleTargets.length === 0 || input.discoveries.length === 0) {
    return {
      plan: clonePlan(input.baseline),
      preview: null,
      applied: false,
      invariantsPassed: true,
      selectedDiscoveryCount: 0,
      skippedKeepFilledTargetIds,
    };
  }

  const preview = previewSurgicalDiscoveryRun({
    baseline: { targets: eligibleBaselineTargets },
    targets: eligibleTargets,
    discoveries: input.discoveries,
    blockedMusicTrackIdsByTargetId: input.blockedMusicTrackIdsByTargetId,
    discoveryCeiling: DISCOVERY_GATE5H_POLICY.discoveryCeiling,
    musicSpacing: DISCOVERY_GATE5H_POLICY.musicSpacing,
    maxDurationDeltaMs: DISCOVERY_GATE5H_POLICY.maxDurationDeltaMs,
  });
  const invariantsPassed = preview.targets.every(
    (target) =>
      target.evidence.podcastSequenceUnchanged &&
      target.evidence.podcastCountUnchanged &&
      target.evidence.musicCountUnchanged &&
      target.evidence.oneForOneReplacement &&
      target.evidence.compositionQualityPreserved &&
      Math.abs(target.evidence.durationDeltaMs) <= preview.evidence.maxDurationDeltaMs &&
      Object.values(target.evidence.blockDurationDeltaMs).every(
        (delta) => Math.abs(delta) <= preview.evidence.maxDurationDeltaMs,
      ),
  );
  if (!invariantsPassed) {
    return {
      plan: clonePlan(input.baseline),
      preview,
      applied: false,
      invariantsPassed: false,
      selectedDiscoveryCount: 0,
      skippedKeepFilledTargetIds,
    };
  }

  const previewByTargetId = new Map(
    preview.targets.map((target) => [target.targetPlaylistId, target] as const),
  );
  const plan: PlanRunResult = {
    targets: input.baseline.targets.map((baselineTarget) => {
      const targetPreview = previewByTargetId.get(baselineTarget.targetPlaylistId);
      const runTarget = targetById.get(baselineTarget.targetPlaylistId);
      if (!targetPreview || !runTarget) {
        return {
          ...baselineTarget,
          result: clonePlanResult(baselineTarget.result),
        };
      }
      return {
        ...baselineTarget,
        result: refreshPlanResult(
          baselineTarget.result,
          targetPreview.items,
          runTarget,
          targetPreview.evidence.compositionQualityAfter,
        ),
      };
    }),
  };

  return {
    plan,
    preview,
    applied: preview.evidence.selectedDiscoveryCount > 0,
    invariantsPassed: true,
    selectedDiscoveryCount: preview.evidence.selectedDiscoveryCount,
    skippedKeepFilledTargetIds,
  };
}

function refreshPlanResult(
  baseline: PlanResult,
  items: PlannedItem[],
  target: RunTarget,
  compositionQualityPassed: boolean,
): PlanResult {
  const clonedItems = items.map((item) => ({ ...item }));
  const totalDurationMs = duration(clonedItems);
  const musicItems = clonedItems.filter((item) => item.type === "MUSIC");
  const podcastItems = clonedItems.filter((item) => item.type === "PODCAST");
  const musicDurationMs = duration(musicItems);
  const podcastDurationMs = duration(podcastItems);
  const actualPodcastPercent =
    totalDurationMs > 0
      ? round1((podcastDurationMs / totalDurationMs) * 100)
      : target.rules.targetDurationMs === 0
        ? target.rules.podcastPercent
        : 0;
  const proportionMode = target.rules.compositionMode === "PROPORTION";
  const podcastBudget =
    (target.rules.targetDurationMs * target.rules.podcastPercent) / 100;
  const musicBudget = target.rules.targetDurationMs - podcastBudget;
  const mixDeviationPoints = proportionMode
    ? round1(Math.abs(actualPodcastPercent - target.rules.podcastPercent))
    : 0;
  const segmentation = baseline.stats.segmentation
    ? refreshSegmentation(baseline.stats.segmentation, clonedItems)
    : undefined;

  return {
    items: clonedItems,
    usedUris: new Set(clonedItems.map((item) => item.uri)),
    stats: {
      ...baseline.stats,
      totalDurationMs,
      musicDurationMs,
      podcastDurationMs,
      musicCount: musicItems.length,
      podcastCount: podcastItems.length,
      actualPodcastPercent,
      podcastShortfallMs: proportionMode
        ? Math.max(0, podcastBudget - podcastDurationMs)
        : 0,
      musicShortfallMs: proportionMode
        ? Math.max(0, musicBudget - musicDurationMs)
        : 0,
      mixDeviationPoints,
      mixQualityPassed: compositionQualityPassed,
      compositionQualityPassed,
      poolExhausted: totalDurationMs < target.rules.targetDurationMs,
      distinctArtistCount: new Set(
        musicItems.map((item) => item.primaryArtistId?.trim()).filter(Boolean),
      ).size,
      distinctAlbumCount: new Set(
        musicItems.map((item) => item.albumId?.trim()).filter(Boolean),
      ).size,
      ...(segmentation ? { segmentation } : {}),
    },
  };
}

function refreshSegmentation(
  segmentation: NonNullable<PlanResult["stats"]["segmentation"]>,
  items: PlannedItem[],
): NonNullable<PlanResult["stats"]["segmentation"]> {
  const blocks = segmentation.blocks.map((block) => {
    const blockItems = items.filter(
      (item) => item.planningBlockIndex === block.index,
    );
    const filledDurationMs = duration(blockItems);
    const musicDurationMs = duration(
      blockItems.filter((item) => item.type === "MUSIC"),
    );
    const podcastDurationMs = duration(
      blockItems.filter((item) => item.type === "PODCAST"),
    );
    return {
      ...block,
      filledDurationMs,
      deficitMs: Math.max(0, block.targetDurationMs - filledDurationMs),
      musicDurationMs,
      podcastDurationMs,
    };
  });
  const filledDurationMs = blocks.reduce(
    (sum, block) => sum + block.filledDurationMs,
    0,
  );
  return {
    ...segmentation,
    filledDurationMs,
    deficitMs: blocks.reduce((sum, block) => sum + block.deficitMs, 0),
    blocks,
  };
}

function clonePlan(plan: PlanRunResult): PlanRunResult {
  return {
    targets: plan.targets.map((target) => ({
      ...target,
      result: clonePlanResult(target.result),
    })),
  };
}

function clonePlanResult(result: PlanResult): PlanResult {
  return {
    items: result.items.map((item) => ({ ...item })),
    usedUris: new Set(result.usedUris),
    stats: {
      ...result.stats,
      ...(result.stats.segmentation
        ? {
            segmentation: {
              ...result.stats.segmentation,
              blocks: result.stats.segmentation.blocks.map((block) => ({ ...block })),
            },
          }
        : {}),
    },
  };
}

function duration(items: Array<{ durationMs: number }>): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function parseBoolean(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}
