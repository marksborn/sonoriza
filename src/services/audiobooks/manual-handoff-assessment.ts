/**
 * AUDIOBOOK-02 Gate D.3: PURE, non-authorizing reconciliation/handoff.
 *
 * The Spotify POST items endpoint documents APPEND semantics for track/episode
 * URIs, but supplies no snapshot precondition; an item=null cannot establish
 * that the attached audiobook survives a write. Accordingly this function
 * NEVER authorizes POST/PUT/DELETE and NEVER returns an execution token.
 *
 * A passing result is ONLY a checklist of candidate items for the user to
 * add through Spotify manually AFTER checking the actual book and position.
 */
import type { SpotifyTargetPlaylistState } from "@/services/spotify/client";
import {
  analyzeOpaqueAudiobookPlaylist,
} from "./opaque-playlist-reconciliation";
import {
  calculateAudiobookVirtualDuration,
} from "./virtual-chapter-duration";

const MAX_SHADOW_AGE_MS = 60 * 60 * 1000;
const MAX_EXTRA_ITEMS = 100;

export type AudiobookD3Target = Readonly<{
  id: string;
  userId: string;
  spotifyPlaylistId: string | null;
  durationMode: "FIXED" | "CALENDAR";
  fixedDurationSeconds: number | null;
  updatePolicy: string;
  compositionMode: string;
}>;

export type AudiobookD3Overlay = Readonly<{
  userId: string;
  targetPlaylistId: string;
  spotifyPlaylistId: string;
  spotifyAudiobookId: string;
  selectedChapterId: string;
  chapterDurationMs: number;
  manualConsumedMs: number;
  selectionMode: "FULL_CHAPTER" | "MANUAL_REMAINDER";
  revision: number;
}>;

export type AudiobookD3Simulation = Readonly<{
  id: string;
  userId: string;
  simulation: boolean;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  summary: unknown;
}>;

export type AudiobookD3Item = Readonly<{
  uri: string;
  spotifyUrl: string;
  contentType: "MUSIC" | "PODCAST";
}>;

export type AudiobookD3Result =
  | Readonly<{
      status: "BLOCKED";
      reason: string;
      spotifyWrites: false;
      authorizedForAutomaticWrite: false;
    }>
  | Readonly<{
      status: "MANUAL_HANDOFF_ONLY";
      runId: string;
      targetPlaylistId: string;
      spotifyPlaylistId: string;
      spotifyPlaylistUrl: string;
      snapshotId: string;
      overlayRevision: number;
      selectedChapterId: string;
      targetDurationMs: number;
      virtualChapterDurationMs: number;
      remainingBudgetMs: number;
      extraDurationMs: number;
      projectedTotalMs: number;
      leftoverMs: number;
      opaqueItemsObserved: number;
      audiobookIdentityVerified: false;
      spotifySnapshotIsWriteAuthorization: false;
      authorizedForAutomaticWrite: false;
      spotifyWrites: false;
      requiresManualBookCheck: true;
      requiresManualChapterSwitch: true;
      itemCount: number;
      items: readonly AudiobookD3Item[];
    }>;

function block(reason: string): AudiobookD3Result {
  return { status: "BLOCKED", reason, spotifyWrites: false, authorizedForAutomaticWrite: false };
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parseUri(uri: unknown): AudiobookD3Item | null {
  if (typeof uri !== "string") return null;
  const match = /^spotify:(track|episode):([A-Za-z0-9]{22})$/.exec(uri);
  if (!match?.[1] || !match[2]) return null;
  return {
    uri,
    contentType: match[1] === "track" ? "MUSIC" : "PODCAST",
    spotifyUrl: `https://open.spotify.com/${match[1]}/${match[2]}`,
  };
}

function findShadow(summary: unknown, targetId: string): Record<string, unknown> | null {
  if (!record(summary) || summary.simulate !== true ||
      summary.collectionComplete !== true || summary.inconclusive !== false ||
      summary.audiobookGateDSimulationOnly !== true ||
      !record(summary.audiobookGateD)) return null;
  const gate = summary.audiobookGateD;
  if (gate.mode !== "SHADOW" || gate.approvalEligible !== false ||
      gate.plannerInfluence !== false || gate.spotifyWrites !== false ||
      !Array.isArray(gate.targets)) return null;
  const matches = gate.targets.filter((target: unknown) =>
    record(target) && target.targetPlaylistId === targetId);
  if (matches.length !== 1 || !record(matches[0]) ||
      matches[0].status !== "READY_SHADOW") return null;
  return matches[0];
}

export function assessAudiobookManualHandoff(input: Readonly<{
  userId: string;
  target: AudiobookD3Target;
  overlay: AudiobookD3Overlay;
  run: AudiobookD3Simulation;
  remote: SpotifyTargetPlaylistState;
  nowMs: number;
}>): AudiobookD3Result {
  const { userId, target, overlay, run, remote, nowMs } = input;
  if (!userId?.trim() || target.userId !== userId || overlay.userId !== userId ||
      run.userId !== userId || target.id !== overlay.targetPlaylistId ||
      !target.spotifyPlaylistId || overlay.spotifyPlaylistId !== target.spotifyPlaylistId) {
    return block("DESTINATION_OR_OWNER_MISMATCH");
  }
  if (target.durationMode !== "FIXED" || target.updatePolicy !== "MANUAL" ||
      target.compositionMode !== "PROPORTION" ||
      !nonNegativeInteger(target.fixedDurationSeconds) ||
      target.fixedDurationSeconds === 0 ||
      !Number.isSafeInteger(target.fixedDurationSeconds * 1000)) {
    return block("UNSUPPORTED_TARGET_POLICY");
  }
  if (!run.simulation || run.status !== "SUCCESS" || !(run.startedAt instanceof Date) ||
      !(run.finishedAt instanceof Date) || !Number.isFinite(nowMs) ||
      run.startedAt.getTime() > nowMs + 30_000 ||
      nowMs - run.finishedAt.getTime() > MAX_SHADOW_AGE_MS ||
      nowMs < run.finishedAt.getTime()) {
    return block("MISSING_OR_STALE_SIMULATION");
  }
  const shadow = findShadow(run.summary, target.id);
  if (!shadow) return block("NO_AUTHORITATIVE_SHADOW_EVIDENCE");
  if (shadow.targetPlaylistId !== target.id ||
      shadow.spotifyPlaylistId !== target.spotifyPlaylistId ||
      shadow.spotifyAudiobookId !== overlay.spotifyAudiobookId ||
      shadow.selectedChapterId !== overlay.selectedChapterId ||
      shadow.overlayRevision !== overlay.revision ||
      shadow.remoteBookPresenceVerified !== false ||
      shadow.wholeBookRemainsInSpotify !== true ||
      shadow.candidateCoverage !== "TARGET_SCOPED_CONFIGURED_SOURCES_ONLY" ||
      shadow.approvalEligible !== false ||
      shadow.spotifyWrites !== false ||
      shadow.plannerInfluence !== false) {
    return block("STALE_OR_UNVERIFIED_SHADOW");
  }
  const virtual = calculateAudiobookVirtualDuration({
    spotifyPlaylistId: overlay.spotifyPlaylistId,
    spotifyAudiobookId: overlay.spotifyAudiobookId,
    selectedChapterId: overlay.selectedChapterId,
    chapterDurationMs: overlay.chapterDurationMs,
    providerDurationMs: null,
    targetDurationMs: target.fixedDurationSeconds * 1000,
    selection: overlay.selectionMode === "FULL_CHAPTER"
      ? { mode: "FULL_CHAPTER" }
      : { mode: "MANUAL_REMAINDER", consumedMs: overlay.manualConsumedMs },
  });
  if (virtual.status !== "READY") return block("INVALID_CURRENT_CHAPTER_BUDGET");
  const budgetFields = [
    "targetDurationMs", "virtualChapterDurationMs", "remainingBudgetMs",
    "projectedExtraDurationMs", "totalProjectedVirtualDurationMs",
    "leftoverAfterProjectedExtrasMs",
  ] as const;
  for (const key of budgetFields) {
    if (!nonNegativeInteger(shadow[key])) return block("CORRUPT_SHADOW_BUDGET");
  }
  if (shadow.targetDurationMs !== virtual.targetDurationMs ||
      shadow.virtualChapterDurationMs !== virtual.effectivePlanningDurationMs ||
      shadow.remainingBudgetMs !== virtual.remainingPlanningDurationMs ||
      shadow.chapterDurationMs !== overlay.chapterDurationMs ||
      shadow.manualConsumedMs !== virtual.manualConsumedMs ||
      shadow.totalProjectedVirtualDurationMs !==
        shadow.virtualChapterDurationMs + shadow.projectedExtraDurationMs ||
      shadow.remainingBudgetMs !==
        shadow.projectedExtraDurationMs + shadow.leftoverAfterProjectedExtrasMs ||
      shadow.totalProjectedVirtualDurationMs > shadow.targetDurationMs) {
    return block("BUDGET_OR_PROGRESS_DRIFT");
  }
  if (!Array.isArray(shadow.projectedContentUris) ||
      shadow.projectedContentUris.length === 0 ||
      shadow.projectedContentUris.length > MAX_EXTRA_ITEMS ||
      shadow.projectedItemCount !== shadow.projectedContentUris.length) {
    return block("EMPTY_OR_OVERSIZED_MANUAL_LIST");
  }
  const items: AudiobookD3Item[] = [];
  const seen = new Set<string>();
  for (const raw of shadow.projectedContentUris) {
    const parsed = parseUri(raw);
    if (!parsed) return block("UNSUPPORTED_SPOTIFY_URI");
    if (seen.has(parsed.uri)) return block("DUPLICATE_PROPOSED_ITEM");
    seen.add(parsed.uri);
    items.push(parsed);
  }
  let observation;
  try {
    observation = analyzeOpaqueAudiobookPlaylist(remote);
  } catch {
    return block("INVALID_OR_UNSTABLE_REMOTE_SNAPSHOT");
  }
  // Zero opaque items cannot prove that the book still exists; any opaque
  // items cannot prove their identities. Report a manual checklist only when
  // the user can inspect at least one candidate opaque entry in Spotify.
  if (observation.opaqueItemCount === 0) {
    return block("NO_OPAQUE_ITEM_FOR_MANUAL_VERIFICATION");
  }
  const remoteKnownUris = new Set(remote.items.map(item => item.uri).filter(
    (uri): uri is string => typeof uri === "string" && uri.length > 0,
  ));
  if (items.some(item => remoteKnownUris.has(item.uri))) {
    return block("PROPOSED_ITEMS_ALREADY_IN_PLAYLIST");
  }
  return {
    status: "MANUAL_HANDOFF_ONLY",
    runId: run.id,
    targetPlaylistId: target.id,
    spotifyPlaylistId: target.spotifyPlaylistId,
    spotifyPlaylistUrl: `https://open.spotify.com/playlist/${target.spotifyPlaylistId}`,
    snapshotId: observation.snapshotId,
    overlayRevision: overlay.revision,
    selectedChapterId: overlay.selectedChapterId,
    targetDurationMs: virtual.targetDurationMs,
    virtualChapterDurationMs: virtual.effectivePlanningDurationMs,
    remainingBudgetMs: virtual.remainingPlanningDurationMs,
    extraDurationMs: shadow.projectedExtraDurationMs as number,
    projectedTotalMs: shadow.totalProjectedVirtualDurationMs as number,
    leftoverMs: shadow.leftoverAfterProjectedExtrasMs as number,
    opaqueItemsObserved: observation.opaqueItemCount,
    audiobookIdentityVerified: false,
    spotifySnapshotIsWriteAuthorization: false,
    authorizedForAutomaticWrite: false,
    spotifyWrites: false,
    requiresManualBookCheck: true,
    requiresManualChapterSwitch: true,
    itemCount: items.length,
    items,
  };
}
