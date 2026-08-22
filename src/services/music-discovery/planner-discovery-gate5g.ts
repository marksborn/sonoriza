import type {
  Candidate,
  PlanRunResult,
  PlannedItem,
  RunTarget,
} from "@/services/playlist-planner";

import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";

export const DISCOVERY_GATE5G_POLICY = {
  version: "gate5g-surgical-replacement-v1",
  discoveryCeiling: 0.2,
  musicSpacing: 5,
  maxDurationDeltaMs: 30_000,
  replacementRule: "ONE_DISCOVERY_FOR_ONE_BASELINE_MUSIC",
  podcastRule: "EXACT_ITEMS_AND_ORDER_IMMUTABLE",
  baselineRule: "BASELINE_IS_AUTHORITY",
  sourceRule: "RESOLVED_SPOTIFY_ONLY",
  budgetRule: "FINAL_MUSIC_CEILING_NO_FORCE_FILL",
  note:
    "Preview-only policy. DESCOBERTA may replace only predetermined MUSIC slots in the already-valid baseline; every accepted discovery removes exactly one baseline MUSIC item and may not alter podcast identity/order/count, composition quality, diversity constraints, or the bounded duration tolerance.",
} as const;

export type Gate5GRejectionReason =
  | "INVALID_DISCOVERY_CANDIDATE"
  | "ALREADY_PRESENT_IN_TARGET"
  | "BLOCKED_TRACK"
  | "DURATION_DELTA_EXCEEDED"
  | "TARGET_DURATION_DELTA_EXCEEDED"
  | "BLOCK_DURATION_DELTA_EXCEEDED"
  | "DUPLICATE_TRACK"
  | "MISSING_ARTIST_ID"
  | "ARTIST_LIMIT"
  | "MISSING_ALBUM_ID"
  | "ALBUM_LIMIT"
  | "QUALITY_REGRESSION";

export type Gate5GReplacement = {
  candidateKey: string;
  overallPosition: number;
  musicOrdinal: number;
  baseline: PlannedItem;
  discovery: Candidate;
  rawScore: number;
  adjustedScore: number;
  historyClass: string;
  pathLabel: string;
  resolutionReason: string;
  durationDeltaMs: number;
};

export type Gate5GAttempt = {
  candidateKey: string;
  overallPosition: number;
  musicOrdinal: number;
  reason: Gate5GRejectionReason;
};

export type Gate5GTargetPreview = {
  targetPlaylistId: string;
  name: string;
  items: PlannedItem[];
  replacements: Gate5GReplacement[];
  attemptsRejected: Gate5GAttempt[];
  evidence: {
    baselineMusicCount: number;
    baselinePodcastCount: number;
    maxDiscoveryCount: number;
    eligibleMusicOrdinals: number[];
    discoveryCount: number;
    discoveryShare: number;
    durationDeltaMs: number;
    blockDurationDeltaMs: Record<string, number>;
    podcastSequenceUnchanged: boolean;
    podcastCountUnchanged: boolean;
    musicCountUnchanged: boolean;
    oneForOneReplacement: boolean;
    compositionQualityBefore: boolean;
    compositionQualityAfter: boolean;
    compositionQualityPreserved: boolean;
  };
};

export type Gate5GRunPreview = {
  targets: Gate5GTargetPreview[];
  unusedDiscoveries: Gate5FResolvedDiscoveryCandidate[];
  invalidDiscoveries: Gate5FResolvedDiscoveryCandidate[];
  evidence: {
    policyVersion: typeof DISCOVERY_GATE5G_POLICY.version;
    inputDiscoveryCount: number;
    usableDiscoveryCount: number;
    invalidDiscoveryCount: number;
    selectedDiscoveryCount: number;
    unusedDiscoveryCount: number;
    discoveryCeiling: number;
    musicSpacing: number;
    maxDurationDeltaMs: number;
  };
};

export function previewSurgicalDiscoveryRun(input: {
  baseline: PlanRunResult;
  targets: RunTarget[];
  discoveries: Gate5FResolvedDiscoveryCandidate[];
  blockedMusicTrackIdsByTargetId?: ReadonlyMap<string, ReadonlySet<string>>;
  discoveryCeiling?: number;
  musicSpacing?: number;
  maxDurationDeltaMs?: number;
}): Gate5GRunPreview {
  const discoveryCeiling = normalizeCeiling(
    input.discoveryCeiling ?? DISCOVERY_GATE5G_POLICY.discoveryCeiling,
  );
  const musicSpacing = normalizePositiveInteger(
    input.musicSpacing ?? DISCOVERY_GATE5G_POLICY.musicSpacing,
    "musicSpacing",
  );
  const maxDurationDeltaMs = normalizeNonNegativeInteger(
    input.maxDurationDeltaMs ?? DISCOVERY_GATE5G_POLICY.maxDurationDeltaMs,
    "maxDurationDeltaMs",
  );

  const invalidDiscoveries: Gate5FResolvedDiscoveryCandidate[] = [];
  const usableDiscoveries: Gate5FResolvedDiscoveryCandidate[] = [];
  const seenDiscoveryIdentities = new Set<string>();
  for (const discovery of [...input.discoveries].sort(byAdjustedScoreThenKey)) {
    if (!isUsableDiscovery(discovery)) {
      invalidDiscoveries.push(discovery);
      continue;
    }
    const identity = candidateIdentity(discovery.candidate);
    if (seenDiscoveryIdentities.has(identity)) {
      invalidDiscoveries.push(discovery);
      continue;
    }
    seenDiscoveryIdentities.add(identity);
    usableDiscoveries.push(discovery);
  }

  const usedDiscoveryKeys = new Set<string>();
  const targetById = new Map(
    input.targets.map((target) => [target.targetPlaylistId, target] as const),
  );
  const previews: Gate5GTargetPreview[] = [];

  for (const baselineTarget of input.baseline.targets) {
    const target = targetById.get(baselineTarget.targetPlaylistId);
    if (!target) {
      throw new Error(
        `DISCOVERY Gate 5G missing RunTarget ${baselineTarget.targetPlaylistId}`,
      );
    }

    const baselineItems = baselineTarget.result.items.map((item) => ({ ...item }));
    const items = baselineItems.map((item) => ({ ...item }));
    const baselineMusicCount = baselineItems.filter((item) => item.type === "MUSIC").length;
    const baselinePodcastCount = baselineItems.length - baselineMusicCount;
    const maxDiscoveryCount = Math.floor(baselineMusicCount * discoveryCeiling + Number.EPSILON);
    const eligibleMusicOrdinals = Array.from(
      { length: maxDiscoveryCount },
      (_, index) => (index + 1) * musicSpacing,
    ).filter((ordinal) => ordinal <= baselineMusicCount);
    const replacements: Gate5GReplacement[] = [];
    const attemptsRejected: Gate5GAttempt[] = [];
    const blockedTrackIds =
      input.blockedMusicTrackIdsByTargetId?.get(target.targetPlaylistId) ?? new Set<string>();

    for (const musicOrdinal of eligibleMusicOrdinals) {
      const itemIndex = itemIndexForMusicOrdinal(items, musicOrdinal);
      if (itemIndex < 0) continue;
      const baselineItem = items[itemIndex]!;

      for (const discovery of usableDiscoveries) {
        if (usedDiscoveryKeys.has(discovery.candidateKey)) continue;
        const reason = replacementRejectionReason({
          items,
          itemIndex,
          baselineItem,
          discovery: discovery.candidate,
          target,
          baselineResult: baselineTarget.result,
          blockedTrackIds,
          replacements,
          maxDurationDeltaMs,
        });
        if (reason) {
          attemptsRejected.push({
            candidateKey: discovery.candidateKey,
            overallPosition: itemIndex + 1,
            musicOrdinal,
            reason,
          });
          continue;
        }

        const replacementItem: PlannedItem = {
          ...discovery.candidate,
          position: baselineItem.position,
          ...(baselineItem.planningBlockIndex == null
            ? {}
            : { planningBlockIndex: baselineItem.planningBlockIndex }),
        };
        items[itemIndex] = replacementItem;
        usedDiscoveryKeys.add(discovery.candidateKey);
        replacements.push({
          candidateKey: discovery.candidateKey,
          overallPosition: itemIndex + 1,
          musicOrdinal,
          baseline: baselineItem,
          discovery: discovery.candidate,
          rawScore: discovery.rawScore,
          adjustedScore: discovery.adjustedScore,
          historyClass: discovery.historyClass,
          pathLabel: discovery.pathLabel,
          resolutionReason: discovery.resolutionReason,
          durationDeltaMs: discovery.candidate.durationMs - baselineItem.durationMs,
        });
        break;
      }
    }

    const beforePodcastUris = podcastUris(baselineItems);
    const afterPodcastUris = podcastUris(items);
    const beforeMusicCount = baselineMusicCount;
    const afterMusicCount = items.filter((item) => item.type === "MUSIC").length;
    const durationDeltaMs = duration(items) - duration(baselineItems);
    const blockDurationDeltaMs = blockDurationDeltas(baselineItems, items);
    const compositionQualityAfter = inferCompositionQuality(
      items,
      target,
      baselineTarget.result.stats.segmentation != null,
      baselineTarget.result.stats.compositionQualityPassed,
    );
    const compositionQualityBefore = baselineTarget.result.stats.compositionQualityPassed;

    previews.push({
      targetPlaylistId: target.targetPlaylistId,
      name: target.name,
      items,
      replacements,
      attemptsRejected,
      evidence: {
        baselineMusicCount,
        baselinePodcastCount,
        maxDiscoveryCount,
        eligibleMusicOrdinals,
        discoveryCount: replacements.length,
        discoveryShare:
          baselineMusicCount > 0 ? replacements.length / baselineMusicCount : 0,
        durationDeltaMs,
        blockDurationDeltaMs,
        podcastSequenceUnchanged:
          JSON.stringify(beforePodcastUris) === JSON.stringify(afterPodcastUris),
        podcastCountUnchanged: beforePodcastUris.length === afterPodcastUris.length,
        musicCountUnchanged: beforeMusicCount === afterMusicCount,
        oneForOneReplacement:
          replacements.length ===
          baselineItems.filter(
            (item, index) => item.type === "MUSIC" && item.uri !== items[index]?.uri,
          ).length,
        compositionQualityBefore,
        compositionQualityAfter,
        compositionQualityPreserved:
          !compositionQualityBefore || compositionQualityAfter,
      },
    });
  }

  const unusedDiscoveries = usableDiscoveries.filter(
    (row) => !usedDiscoveryKeys.has(row.candidateKey),
  );
  return {
    targets: previews,
    unusedDiscoveries,
    invalidDiscoveries,
    evidence: {
      policyVersion: DISCOVERY_GATE5G_POLICY.version,
      inputDiscoveryCount: input.discoveries.length,
      usableDiscoveryCount: usableDiscoveries.length,
      invalidDiscoveryCount: invalidDiscoveries.length,
      selectedDiscoveryCount: usedDiscoveryKeys.size,
      unusedDiscoveryCount: unusedDiscoveries.length,
      discoveryCeiling,
      musicSpacing,
      maxDurationDeltaMs,
    },
  };
}

function replacementRejectionReason(input: {
  items: PlannedItem[];
  itemIndex: number;
  baselineItem: PlannedItem;
  discovery: Candidate;
  target: RunTarget;
  baselineResult: PlanRunResult["targets"][number]["result"];
  blockedTrackIds: ReadonlySet<string>;
  replacements: Gate5GReplacement[];
  maxDurationDeltaMs: number;
}): Gate5GRejectionReason | null {
  const { discovery } = input;
  if (
    discovery.type !== "MUSIC" ||
    !discovery.uri.trim() ||
    !discovery.spotifyTrackId?.trim() ||
    discovery.durationMs <= 0
  ) {
    return "INVALID_DISCOVERY_CANDIDATE";
  }

  if (
    input.items.some(
      (item, index) =>
        index !== input.itemIndex &&
        (item.uri === discovery.uri ||
          (item.spotifyTrackId && item.spotifyTrackId === discovery.spotifyTrackId)),
    )
  ) {
    return "ALREADY_PRESENT_IN_TARGET";
  }
  if (input.blockedTrackIds.has(discovery.spotifyTrackId)) return "BLOCKED_TRACK";

  const replacementDelta = discovery.durationMs - input.baselineItem.durationMs;
  if (Math.abs(replacementDelta) > input.maxDurationDeltaMs) {
    return "DURATION_DELTA_EXCEEDED";
  }
  const priorDelta = input.replacements.reduce((sum, row) => sum + row.durationDeltaMs, 0);
  if (Math.abs(priorDelta + replacementDelta) > input.maxDurationDeltaMs) {
    return "TARGET_DURATION_DELTA_EXCEEDED";
  }

  if (input.baselineItem.planningBlockIndex != null) {
    const blockIndex = input.baselineItem.planningBlockIndex;
    const priorBlockDelta = input.replacements
      .filter((row) => row.baseline.planningBlockIndex === blockIndex)
      .reduce((sum, row) => sum + row.durationDeltaMs, 0);
    if (Math.abs(priorBlockDelta + replacementDelta) > input.maxDurationDeltaMs) {
      return "BLOCK_DURATION_DELTA_EXCEEDED";
    }
  }

  const tentative = input.items.map((item, index) =>
    index === input.itemIndex
      ? ({
          ...discovery,
          position: input.baselineItem.position,
          ...(input.baselineItem.planningBlockIndex == null
            ? {}
            : { planningBlockIndex: input.baselineItem.planningBlockIndex }),
        } as PlannedItem)
      : item,
  );

  if (hasDuplicateMusicIdentity(tentative)) return "DUPLICATE_TRACK";

  const artistLimit = normalizeLimit(input.target.rules.maxTracksPerArtist);
  if (artistLimit !== null) {
    const artistId = discovery.primaryArtistId?.trim();
    if (!artistId) return "MISSING_ARTIST_ID";
    const count = tentative.filter(
      (item) => item.type === "MUSIC" && item.primaryArtistId?.trim() === artistId,
    ).length;
    if (count > artistLimit) return "ARTIST_LIMIT";
  }

  const albumLimit = normalizeLimit(input.target.rules.maxTracksPerAlbum);
  if (albumLimit !== null) {
    const albumId = discovery.albumId?.trim();
    if (!albumId) return "MISSING_ALBUM_ID";
    const count = tentative.filter(
      (item) => item.type === "MUSIC" && item.albumId?.trim() === albumId,
    ).length;
    if (count > albumLimit) return "ALBUM_LIMIT";
  }

  const qualityAfter = inferCompositionQuality(
    tentative,
    input.target,
    input.baselineResult.stats.segmentation != null,
    input.baselineResult.stats.compositionQualityPassed,
  );
  if (input.baselineResult.stats.compositionQualityPassed && !qualityAfter) {
    return "QUALITY_REGRESSION";
  }
  return null;
}

function inferCompositionQuality(
  items: PlannedItem[],
  target: RunTarget,
  segmented: boolean,
  baselineQuality: boolean,
): boolean {
  if (target.rules.compositionMode === "SEQUENCE") {
    // MUSIC replaces MUSIC in the same slot. The content-type pattern, slot
    // count, podcast identity and sequence stop semantics therefore cannot
    // regress merely because the MUSIC identity changed.
    return baselineQuality;
  }
  const totalDurationMs = duration(items);
  const podcastDurationMs = items
    .filter((item) => item.type === "PODCAST")
    .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
  const actualPodcastPercent =
    totalDurationMs > 0 ? (podcastDurationMs / totalDurationMs) * 100 : 0;
  const mixDeviationPoints = Math.abs(
    actualPodcastPercent - target.rules.podcastPercent,
  );
  const durationGate = segmented || totalDurationMs >= target.rules.targetDurationMs;
  return target.rules.targetDurationMs === 0 ||
    (mixDeviationPoints <= 10 + Number.EPSILON && durationGate);
}

function hasDuplicateMusicIdentity(items: PlannedItem[]): boolean {
  const seenUris = new Set<string>();
  const seenTrackIds = new Set<string>();
  for (const item of items) {
    if (item.type !== "MUSIC") continue;
    if (seenUris.has(item.uri)) return true;
    seenUris.add(item.uri);
    const trackId = item.spotifyTrackId?.trim();
    if (!trackId) continue;
    if (seenTrackIds.has(trackId)) return true;
    seenTrackIds.add(trackId);
  }
  return false;
}

function itemIndexForMusicOrdinal(items: PlannedItem[], ordinal: number): number {
  let seen = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.type !== "MUSIC") continue;
    seen += 1;
    if (seen === ordinal) return index;
  }
  return -1;
}

function podcastUris(items: PlannedItem[]): string[] {
  return items.filter((item) => item.type === "PODCAST").map((item) => item.uri);
}

function duration(items: PlannedItem[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
}

function blockDurationDeltas(
  baseline: PlannedItem[],
  preview: PlannedItem[],
): Record<string, number> {
  const keys = new Set<number>();
  for (const item of [...baseline, ...preview]) {
    if (item.planningBlockIndex != null) keys.add(item.planningBlockIndex);
  }
  return Object.fromEntries(
    [...keys].sort((a, b) => a - b).map((blockIndex) => {
      const before = baseline
        .filter((item) => item.planningBlockIndex === blockIndex)
        .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
      const after = preview
        .filter((item) => item.planningBlockIndex === blockIndex)
        .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
      return [String(blockIndex), after - before];
    }),
  );
}

function isUsableDiscovery(discovery: Gate5FResolvedDiscoveryCandidate): boolean {
  const candidate = discovery.candidate;
  return Boolean(
    candidate.type === "MUSIC" &&
      candidate.uri.trim() &&
      candidate.spotifyTrackId?.trim() &&
      candidate.primaryArtistId?.trim() &&
      candidate.durationMs > 0 &&
      Number.isFinite(discovery.adjustedScore),
  );
}

function candidateIdentity(candidate: Candidate): string {
  return candidate.spotifyTrackId?.trim()
    ? `track:${candidate.spotifyTrackId.trim()}`
    : `uri:${candidate.uri}`;
}

function byAdjustedScoreThenKey(
  a: Gate5FResolvedDiscoveryCandidate,
  b: Gate5FResolvedDiscoveryCandidate,
): number {
  return b.adjustedScore - a.adjustedScore || a.candidateKey.localeCompare(b.candidateKey);
}

function normalizeLimit(value: number | null | undefined): number | null {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function normalizeCeiling(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("DISCOVERY Gate 5G discoveryCeiling must be between 0 and 1");
  }
  return value;
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`DISCOVERY Gate 5G ${label} must be a positive integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`DISCOVERY Gate 5G ${label} must be a non-negative integer`);
  }
  return value;
}
