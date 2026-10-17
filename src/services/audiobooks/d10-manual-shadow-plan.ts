/**
 * AUDIOBOOK-02 D.10: real candidate pools, manual chapter budget, SHADOW ONLY.
 * The whole show/book is NOT a candidate and is NEVER written to Spotify.
 * This computes a bounded counterfactual over the currently configured,
 * scoped sources; it cannot be used to approve a real playlist mutation.
 */
import {
  planPlaylist, type Candidate, type PlannerPools, type PlaylistRules,
} from "@/services/playlist-planner";

type ManualNote = Readonly<{
  userId: string; targetPlaylistId: string; spotifyShowId: string | null;
  bookTitle: string; chapterLabel: string;
  chapterDurationMs: number; consumedMs: number;
  targetDurationMs: number; revision: number; evidenceSource: string;
}>;

export type ManualShadowPlanInput = Readonly<{
  userId: string;
  target: Readonly<{
    id: string; userId: string; spotifyPlaylistId: string | null;
    durationMode: "FIXED" | "CALENDAR"; fixedDurationSeconds: number | null;
    updatePolicy: string;
  }>;
  notebook: ManualNote;
  rules: PlaylistRules;
  pools: PlannerPools;
  effectiveSourceIds: ReadonlySet<string>;
  blockedSpotifyMusicTrackIds?: ReadonlySet<string>;
  hasDurationBlocks: boolean;
  hasOtherActiveNotebook: boolean;
}>;

function abstain(reason: string) {
  return { status: "ABSTAIN" as const, reason,
    plannerInfluence: false as const, spotifyWrites: false as const,
    approvalEligible: false as const };
}

function scoped(
  pool: readonly Candidate[],
  sources: ReadonlySet<string>,
  blocked?: ReadonlySet<string>,
): Candidate[] {
  return pool.filter(c =>
    typeof c.sourcePlaylistId === "string" &&
    sources.has(c.sourcePlaylistId) &&
    Number.isSafeInteger(c.durationMs) && c.durationMs > 0 &&
    (c.type !== "MUSIC" || !c.spotifyTrackId ||
      !blocked?.has(c.spotifyTrackId)),
  );
}

export function projectManualShowChapterPlan(input: ManualShadowPlanInput) {
  const { userId, notebook: n, target: t, rules } = input;
  if (!userId || n.userId !== userId || t.userId !== userId ||
      n.targetPlaylistId !== t.id || !t.spotifyPlaylistId ||
      input.hasOtherActiveNotebook) return abstain("OWNER_TARGET_OR_ACTIVE_BOOK_CONFLICT");
  if (!n.spotifyShowId || !/^[A-Za-z0-9]{22}$/.test(n.spotifyShowId) ||
      !n.bookTitle.trim() || !n.chapterLabel.trim() ||
      n.evidenceSource !== "USER_DECLARED_UNVERIFIED" ||
      !Number.isSafeInteger(n.revision) || n.revision < 1) {
    return abstain("MISSING_UNVERIFIED_SHOW_REFERENCE_OR_REVISION");
  }
  if (t.durationMode !== "FIXED" || t.updatePolicy !== "MANUAL" ||
      t.fixedDurationSeconds === null || !Number.isSafeInteger(t.fixedDurationSeconds) ||
      rules.compositionMode !== "PROPORTION" || input.hasDurationBlocks ||
      rules.targetDurationMs !== t.fixedDurationSeconds * 1000 ||
      rules.targetDurationMs <= 0) {
    return abstain("UNSUPPORTED_TARGET_OR_POLICY");
  }
  const virtual = n.chapterDurationMs - n.consumedMs;
  if (!Number.isSafeInteger(n.chapterDurationMs) ||
      !Number.isSafeInteger(n.consumedMs) || n.consumedMs < 0 ||
      n.chapterDurationMs <= 0 || virtual <= 0 ||
      virtual > rules.targetDurationMs ||
      n.targetDurationMs !== rules.targetDurationMs) {
    return abstain("INVALID_VIRTUAL_BUDGET");
  }
  if (input.effectiveSourceIds.size === 0) return abstain("NO_CONFIGURED_SOURCES");
  const remaining = rules.targetDurationMs - virtual;
  const result = planPlaylist({
    rules: { ...rules, targetDurationMs: remaining },
    pools: {
      music: scoped(
        input.pools.music, input.effectiveSourceIds,
        input.blockedSpotifyMusicTrackIds,
      ),
      podcasts: scoped(input.pools.podcasts, input.effectiveSourceIds),
    },
    strictDurationBoundary: true,
  });
  const extra = result.stats.totalDurationMs;
  if (!Number.isSafeInteger(extra) || extra < 0 || extra > remaining) {
    return abstain("COUNTERFACTUAL_OVER_BUDGET");
  }
  return {
    status: "READY_SHADOW" as const,
    targetPlaylistId: t.id,
    spotifyPlaylistId: t.spotifyPlaylistId,
    sourceReference: "https://open.spotify.com/show/" + n.spotifyShowId,
    evidenceSource: "USER_DECLARED_UNVERIFIED" as const,
    notebookRevision: n.revision,
    chapterLabel: n.chapterLabel,
    targetDurationMs: rules.targetDurationMs,
    virtualChapterDurationMs: virtual,
    remainingBudgetMs: remaining,
    projectedItemCount: result.items.length,
    projectedMusicDurationMs: result.stats.musicDurationMs,
    projectedPodcastDurationMs: result.stats.podcastDurationMs,
    projectedExtraDurationMs: extra,
    totalVirtualDurationMs: virtual + extra,
    leftoverMs: remaining - extra,
    candidateCoverage: "TARGET_SCOPED_CONFIGURED_SOURCES_ONLY" as const,
    wholeBookRemainsInSpotify: true as const,
    remoteBookPresenceVerified: false as const,
    manualSpotifyControlRequired: true as const,
    plannerInfluence: false as const,
    spotifyWrites: false as const,
    approvalEligible: false as const,
  };
}
