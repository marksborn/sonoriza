/**
 * AUDIOBOOK-02 Gate D: bounded, pure, simulation-only planner projection.
 *
 * The Spotify playlist still contains one opaque WHOLE audiobook which we
 * cannot identify reliably from /playlists/{id}/items. Never turn the book
 * into a MUSIC/PODCAST Candidate, never feed this result to provider writers,
 * and never treat this projection as CONFIG-04 real-run approval.
 *
 * Projection covers PROPORTION + FIXED targets with only candidates carrying
 * explicit target-scoped source provenance. SEQUENCE, PER_EVENT and preserved
 * items require a separately verified product contract.
 */
import { planPlaylist, type Candidate, type PlannerPools, type PlaylistRules } from "@/services/playlist-planner";
import {
  calculateAudiobookVirtualDuration,
  type AudiobookChapterPlanningSelection,
} from "./virtual-chapter-duration";

export type AudiobookGateDOverlay = Readonly<{
  userId: string;
  targetPlaylistId: string;
  spotifyPlaylistId: string;
  spotifyAudiobookId: string;
  selectedChapterId: string;
  chapterDurationMs: number;
  providerDurationMs: number | null;
  manualConsumedMs: number;
  selectionMode: "FULL_CHAPTER" | "MANUAL_REMAINDER";
  revision: number;
}>;

export type AudiobookGateDTarget = Readonly<{
  id: string;
  userId: string;
  spotifyPlaylistId: string | null;
  durationMode: "FIXED" | "CALENDAR";
  fixedDurationSeconds: number | null;
  updatePolicy: string;
}>;

export type AudiobookGateDProjectionInput = Readonly<{
  userId: string;
  target: AudiobookGateDTarget;
  overlay: AudiobookGateDOverlay;
  rules: PlaylistRules;
  pools: PlannerPools;
  /** Configured and enabled source ids selected by the existing target. */
  effectiveSourceIds: ReadonlySet<string>;
  blockedSpotifyMusicTrackIds?: ReadonlySet<string>;
}>;

export type AudiobookGateDProjection =
  | Readonly<{
      status: "ABSTAIN";
      reason: string;
      plannerInfluence: false;
      spotifyWrites: false;
      approvalEligible: false;
    }>
  | Readonly<{
      status: "READY_SHADOW";
      targetPlaylistId: string;
      spotifyPlaylistId: string;
      spotifyAudiobookId: string;
      selectedChapterId: string;
      overlayRevision: number;
      wholeBookRemainsInSpotify: true;
      manualSpotifyControlRequired: true;
      remoteBookPresenceVerified: false;
      plannerInfluence: false;
      spotifyWrites: false;
      approvalEligible: false;
      targetDurationMs: number;
      chapterDurationMs: number;
      manualConsumedMs: number;
      virtualChapterDurationMs: number;
      remainingBudgetMs: number;
      candidateCoverage: "TARGET_SCOPED_CONFIGURED_SOURCES_ONLY";
      projectedItemCount: number;
      projectedMusicDurationMs: number;
      projectedPodcastDurationMs: number;
      projectedExtraDurationMs: number;
      totalProjectedVirtualDurationMs: number;
      leftoverAfterProjectedExtrasMs: number;
      projectedContentUris: readonly string[];
    }>;

function abstain(reason: string): AudiobookGateDProjection {
  return {
    status: "ABSTAIN",
    reason,
    plannerInfluence: false,
    spotifyWrites: false,
    approvalEligible: false,
  };
}

function selectionFor(overlay: AudiobookGateDOverlay): AudiobookChapterPlanningSelection {
  return overlay.selectionMode === "FULL_CHAPTER"
    ? { mode: "FULL_CHAPTER" }
    : { mode: "MANUAL_REMAINDER", consumedMs: overlay.manualConsumedMs };
}

function strictlyEligible(
  candidates: readonly Candidate[],
  effectiveSourceIds: ReadonlySet<string>,
  blockedSpotifyMusicTrackIds?: ReadonlySet<string>,
): Candidate[] {
  return candidates.filter(candidate =>
    typeof candidate.sourcePlaylistId === "string" &&
    effectiveSourceIds.has(candidate.sourcePlaylistId) &&
    Number.isSafeInteger(candidate.durationMs) &&
    candidate.durationMs > 0 &&
    (candidate.type !== "MUSIC" ||
      !candidate.spotifyTrackId ||
      !blockedSpotifyMusicTrackIds?.has(candidate.spotifyTrackId))
  );
}

export function projectAudiobookVirtualChapterPlan(
  input: AudiobookGateDProjectionInput,
): AudiobookGateDProjection {
  const { overlay, target, rules, pools } = input;
  if (!input.userId?.trim() || target.userId !== input.userId ||
      overlay.userId !== input.userId || overlay.targetPlaylistId !== target.id ||
      !target.spotifyPlaylistId || overlay.spotifyPlaylistId !== target.spotifyPlaylistId) {
    return abstain("IDENTITY_OR_DESTINATION_DRIFT");
  }
  if (target.durationMode !== "FIXED" ||
      target.updatePolicy !== "MANUAL" ||
      rules.compositionMode !== "PROPORTION" ||
      !Number.isSafeInteger(target.fixedDurationSeconds) ||
      !target.fixedDurationSeconds ||
      target.fixedDurationSeconds <= 0 ||
      !Number.isSafeInteger(target.fixedDurationSeconds * 1000) ||
      rules.targetDurationMs !== target.fixedDurationSeconds * 1000) {
    return abstain("UNSUPPORTED_TARGET_CONFIGURATION");
  }
  if (!Number.isSafeInteger(overlay.revision) || overlay.revision < 0 ||
      overlay.selectionMode !== "FULL_CHAPTER" &&
      overlay.selectionMode !== "MANUAL_REMAINDER" ||
      (overlay.selectionMode === "FULL_CHAPTER" && overlay.manualConsumedMs !== 0)) {
    return abstain("INVALID_OVERLAY_STATE");
  }
  if (input.effectiveSourceIds.size === 0) {
    return abstain("NO_CONFIGURED_TARGET_SOURCES");
  }
  const chapter = calculateAudiobookVirtualDuration({
    spotifyPlaylistId: overlay.spotifyPlaylistId,
    spotifyAudiobookId: overlay.spotifyAudiobookId,
    selectedChapterId: overlay.selectedChapterId,
    chapterDurationMs: overlay.chapterDurationMs,
    providerDurationMs: overlay.providerDurationMs,
    targetDurationMs: rules.targetDurationMs,
    selection: selectionFor(overlay),
  });
  if (chapter.status !== "READY") {
    return abstain("VIRTUAL_CHAPTER_" + chapter.reason);
  }
  const scopedPools: PlannerPools = {
    music: strictlyEligible(
      pools.music, input.effectiveSourceIds, input.blockedSpotifyMusicTrackIds,
    ),
    podcasts: strictlyEligible(pools.podcasts, input.effectiveSourceIds),
  };
  // This is the existing canonical pure per-target selector over a reduced
  // budget. It does NOT model the opaque item's remote placement, playback,
  // cross-target reservations, discovery, reserve suffix, or live snapshot.
  const projected = planPlaylist({
    rules: { ...rules, targetDurationMs: chapter.remainingPlanningDurationMs },
    pools: scopedPools,
    strictDurationBoundary: true,
  });
  const extras = projected.stats.totalDurationMs;
  if (extras > chapter.remainingPlanningDurationMs ||
      !Number.isSafeInteger(extras) || extras < 0) {
    return abstain("PROJECTED_EXTRAS_OVER_BUDGET");
  }
  return {
    status: "READY_SHADOW",
    targetPlaylistId: target.id,
    spotifyPlaylistId: overlay.spotifyPlaylistId,
    spotifyAudiobookId: overlay.spotifyAudiobookId,
    selectedChapterId: overlay.selectedChapterId,
    overlayRevision: overlay.revision,
    wholeBookRemainsInSpotify: true,
    manualSpotifyControlRequired: true,
    remoteBookPresenceVerified: false,
    plannerInfluence: false,
    spotifyWrites: false,
    approvalEligible: false,
    targetDurationMs: chapter.targetDurationMs,
    chapterDurationMs: chapter.chapterDurationMs,
    manualConsumedMs: chapter.manualConsumedMs,
    virtualChapterDurationMs: chapter.effectivePlanningDurationMs,
    remainingBudgetMs: chapter.remainingPlanningDurationMs,
    candidateCoverage: "TARGET_SCOPED_CONFIGURED_SOURCES_ONLY",
    projectedItemCount: projected.items.length,
    projectedMusicDurationMs: projected.stats.musicDurationMs,
    projectedPodcastDurationMs: projected.stats.podcastDurationMs,
    projectedExtraDurationMs: extras,
    totalProjectedVirtualDurationMs: chapter.effectivePlanningDurationMs + extras,
    leftoverAfterProjectedExtrasMs: chapter.remainingPlanningDurationMs - extras,
    projectedContentUris: projected.items.map(item => item.uri),
  };
}
