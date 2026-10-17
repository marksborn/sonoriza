/**
 * AUDIOBOOK-02 Gate D.4 — offline-only end-to-end rehearsal.
 *
 * DO NOT import this in application routes or scheduled jobs. An injected GET
 * reader supplies Spotify catalogue/chapter fixtures; no token or network call
 * is constructed here. A passing fixture NEVER proves production-market
 * availability, remote audiobook identity, or permission to mutate Spotify.
 */
import type { PlaylistRules, PlannerPools } from "@/services/playlist-planner";
import type { SpotifyTargetPlaylistState } from "@/services/spotify/client";
import {
  assertSpotifyAudiobookChapterEvidence,
  type AudiobookEvidenceRead,
} from "./spotify-chapter-evidence";
import {
  loadAudiobookChapterList,
} from "./spotify-chapter-list";
import {
  projectAudiobookVirtualChapterPlan,
  type AudiobookGateDOverlay,
  type AudiobookGateDTarget,
} from "./gate-d-shadow-planner";
import {
  assessAudiobookManualHandoff,
  type AudiobookD3Simulation,
} from "./manual-handoff-assessment";

import { DOCUMENTED_SPOTIFY_AUDIOBOOK_MARKETS } from "./d5-account-capability";
const DOCUMENTED_AUDIOBOOK_MARKETS = new Set<string>(
  DOCUMENTED_SPOTIFY_AUDIOBOOK_MARKETS,
);

/** Verdicts all mean "not approved for production", even when the dry run passes. */
export type D4HomologationReason =
  | "ACCOUNT_MARKET_UNVERIFIED"
  | "AUDIOBOOK_CATALOG_MARKET_NOT_DOCUMENTED"
  | "CATALOG_OR_CHAPTER_GET_UNAVAILABLE"
  | "CHAPTER_NOT_IN_CATALOG"
  | "CHAPTER_EVIDENCE_DRIFT"
  | "PLANNER_ABSTAIN"
  | "MANUAL_HANDOFF_BLOCKED";

export type D4HomologationResult =
  | Readonly<{
      status: "BLOCKED_OFFLINE";
      reason: D4HomologationReason;
      details?: string;
      fixtureOnly: true;
      realSpotifyAvailabilityVerified: false;
      remoteAudiobookIdentityVerified: false;
      spotifyWrites: false;
      productionApproved: false;
    }>
  | Readonly<{
      status: "PASS_OFFLINE_MANUAL_ONLY";
      fixtureOnly: true;
      realSpotifyAvailabilityVerified: false;
      remoteAudiobookIdentityVerified: false;
      spotifyWrites: false;
      productionApproved: false;
      accountMarketFixture: string;
      audiobookName: string;
      chapterName: string;
      virtualChapterDurationMs: number;
      remainingBudgetMs: number;
      extraDurationMs: number;
      leftoverMs: number;
      handoffCount: number;
      spotifyUrlsForHumanReview: readonly string[];
    }>;

export type D4OfflineRehearsalInput = Readonly<{
  userId: string;
  /** Must be supplied by a test fixture, NEVER inferred from IP or user locale. */
  accountMarketFixture: string | null;
  target: AudiobookGateDTarget;
  overlay: AudiobookGateDOverlay;
  rules: PlaylistRules;
  pools: PlannerPools;
  effectiveSourceIds: ReadonlySet<string>;
  remote: SpotifyTargetPlaylistState;
  nowMs: number;
  /** Injected read-only simulated provider. No real tokens. */
  readFixture: AudiobookEvidenceRead;
}>;

function blocked(reason: D4HomologationReason, details?: string): D4HomologationResult {
  return {
    status: "BLOCKED_OFFLINE",
    reason,
    ...(details ? { details } : {}),
    fixtureOnly: true,
    realSpotifyAvailabilityVerified: false,
    remoteAudiobookIdentityVerified: false,
    spotifyWrites: false,
    productionApproved: false,
  };
}

export function documentedAudiobookMarketStatus(country: string | null) {
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    return "ACCOUNT_MARKET_UNVERIFIED" as const;
  }
  return DOCUMENTED_AUDIOBOOK_MARKETS.has(country)
    ? "DOCUMENTED_MARKET" as const
    : "AUDIOBOOK_CATALOG_MARKET_NOT_DOCUMENTED" as const;
}

/**
 * Exercises EXACT production pure functions:
 * - Spotify catalogue pagination + chapter ownership/playability;
 * - Gate D virtual-chapter planner;
 * - Gate D.3 handoff policy with a synthesized (not real) SUCCESS simulation;
 * - remote item=null observation.
 *
 * This is a fixture orchestration, not a live Spotify availability check.
 */
export async function rehearseAudiobookManualFlowOffline(
  input: D4OfflineRehearsalInput,
): Promise<D4HomologationResult> {
  const market = documentedAudiobookMarketStatus(input.accountMarketFixture);
  if (market !== "DOCUMENTED_MARKET") return blocked(market);
  if (!input.userId || input.target.userId !== input.userId ||
      input.overlay.userId !== input.userId ||
      input.overlay.targetPlaylistId !== input.target.id ||
      input.target.spotifyPlaylistId !== input.overlay.spotifyPlaylistId) {
    return blocked("CHAPTER_EVIDENCE_DRIFT");
  }
  let catalog;
  let evidence;
  try {
    catalog = await loadAudiobookChapterList(
      input.overlay.spotifyAudiobookId,
      input.readFixture,
    );
    evidence = await assertSpotifyAudiobookChapterEvidence({
      spotifyAudiobookId: input.overlay.spotifyAudiobookId,
      selectedChapterId: input.overlay.selectedChapterId,
    }, input.readFixture);
  } catch {
    // Treat 403, 404, 429, invalid bodies and simulated network failures
    // equally as non-authorizing. Never guess the reason was the account market.
    return blocked("CATALOG_OR_CHAPTER_GET_UNAVAILABLE");
  }
  const selected = catalog.chapters.filter(chapter =>
    chapter.id === evidence.selectedChapterId && chapter.playable);
  if (selected.length !== 1) return blocked("CHAPTER_NOT_IN_CATALOG");
  if (selected[0]?.durationMs !== evidence.chapterDurationMs ||
      input.overlay.chapterDurationMs !== evidence.chapterDurationMs ||
      input.overlay.spotifyAudiobookId !== evidence.spotifyAudiobookId) {
    return blocked("CHAPTER_EVIDENCE_DRIFT");
  }
  const projection = projectAudiobookVirtualChapterPlan({
    userId: input.userId,
    target: input.target,
    overlay: input.overlay,
    rules: input.rules,
    pools: input.pools,
    effectiveSourceIds: input.effectiveSourceIds,
  });
  if (projection.status !== "READY_SHADOW") {
    return blocked("PLANNER_ABSTAIN", projection.reason);
  }

  // Mirror actual Gate D shadow summary fields, without saving a run or
  // creating a CONFIG-04 approval artifact.
  const summary = {
    simulate: true,
    collectionComplete: true,
    inconclusive: false,
    qualityPassed: false,
    audiobookGateDSimulationOnly: true,
    audiobookGateD: {
      mode: "SHADOW",
      simulationOnly: true,
      plannerInfluence: false,
      spotifyWrites: false,
      approvalEligible: false,
      targets: [projection],
    },
  } as const;
  const dryRun: AudiobookD3Simulation = {
    id: "D4_OFFLINE_FIXTURE_NOT_REAL_RUN",
    userId: input.userId,
    simulation: true,
    status: "SUCCESS",
    startedAt: new Date(input.nowMs - 2000),
    finishedAt: new Date(input.nowMs - 1000),
    summary,
  };
  const handoff = assessAudiobookManualHandoff({
    userId: input.userId,
    target: {
      ...input.target,
      compositionMode: input.rules.compositionMode,
    },
    overlay: input.overlay,
    run: dryRun,
    remote: input.remote,
    nowMs: input.nowMs,
  });
  if (handoff.status !== "MANUAL_HANDOFF_ONLY") {
    return blocked("MANUAL_HANDOFF_BLOCKED", handoff.reason);
  }
  return {
    status: "PASS_OFFLINE_MANUAL_ONLY",
    fixtureOnly: true,
    realSpotifyAvailabilityVerified: false,
    remoteAudiobookIdentityVerified: false,
    spotifyWrites: false,
    productionApproved: false,
    accountMarketFixture: input.accountMarketFixture!,
    audiobookName: evidence.audiobookName,
    chapterName: evidence.chapterName,
    virtualChapterDurationMs: handoff.virtualChapterDurationMs,
    remainingBudgetMs: handoff.remainingBudgetMs,
    extraDurationMs: handoff.extraDurationMs,
    leftoverMs: handoff.leftoverMs,
    handoffCount: handoff.itemCount,
    spotifyUrlsForHumanReview: handoff.items.map(item => item.spotifyUrl),
  };
}
