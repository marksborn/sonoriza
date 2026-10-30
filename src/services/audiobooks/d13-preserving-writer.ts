import { AsyncLocalStorage } from "node:async_hooks";

import type { DurationPlanningBlock, RunTarget } from "@/services/playlist-planner";
import type { SpotifyTargetPlaylistState } from "@/services/spotify/client";

/**
 * AUDIOBOOK-02 D.13 (#489) — generate AROUND a whole book added manually to a
 * Spotify playlist protected by a D.12 library association.
 *
 * The book is an opaque remote item (`item=null`, or a non track/episode
 * object). The preserving writer therefore never replaces the playlist: it
 * deletes only `spotify:track:` / `spotify:episode:` URIs and appends the new
 * plan, then re-reads the playlist and requires every other item to still be
 * there. The current chapter's remaining duration is reserved from the
 * planning budget (virtual duration; Spotify still shows the whole book).
 *
 * Opt-in per target: AUDIOBOOK02_PRESERVING_WRITER_MODE=ACTIVE and the target
 * in AUDIOBOOK02_PRESERVING_WRITER_TARGET_IDS. KEEP_FILLED targets, legacy
 * overlays, manual notebooks and archived readings stay blocked.
 */

export type AudiobookPreservingPermit = Readonly<{
  userId: string;
  spotifyPlaylistId: string;
}>;

const permitStorage = new AsyncLocalStorage<AudiobookPreservingPermit>();

export function runWithAudiobookPreservingPermit<T>(
  permit: AudiobookPreservingPermit,
  callback: () => Promise<T>,
): Promise<T> {
  return permitStorage.run(permit, callback);
}

/** True only inside the D.13 writer for this exact user and playlist. */
export function audiobookPreservingPermitActive(
  userId: string,
  spotifyPlaylistId: string,
): boolean {
  const permit = permitStorage.getStore();
  return Boolean(
    permit &&
      permit.userId === userId &&
      permit.spotifyPlaylistId === spotifyPlaylistId,
  );
}

/** The permit never covers PUT (replace) or PATCH (reorder). */
export function audiobookPreservingPermitAllows(
  userId: string,
  spotifyPlaylistId: string,
  method: string,
): boolean {
  const normalized = method.toUpperCase();
  return (
    (normalized === "POST" || normalized === "DELETE") &&
    audiobookPreservingPermitActive(userId, spotifyPlaylistId)
  );
}

export type AudiobookPreservingTargetInput = Readonly<{
  targetPlaylistId: string;
  spotifyPlaylistId: string | null;
  updatePolicy: "MANUAL" | "KEEP_FILLED" | "REBUILD_DAILY";
  /** Protected only by D.12 library associations (no overlay/notebook/archive). */
  libraryProtectedOnly: boolean;
  activeReading: Readonly<{ chapterDurationMs: number; consumedMs: number }> | null;
}>;

export type AudiobookPreservingDecision = Readonly<{
  targetPlaylistId: string;
  eligible: boolean;
  reason:
    | "ELIGIBLE"
    | "MODE_OFF"
    | "TARGET_NOT_ALLOWLISTED"
    | "KEEP_FILLED_NOT_SUPPORTED"
    | "OTHER_AUDIOBOOK_PROTECTION"
    | "NO_ACTIVE_READING"
    | "NO_SPOTIFY_PLAYLIST";
  reservedMs: number;
}>;

export function resolveAudiobookPreservingTarget(
  env: Readonly<Record<string, string | undefined>>,
  input: AudiobookPreservingTargetInput,
): AudiobookPreservingDecision {
  const decision = (
    reason: AudiobookPreservingDecision["reason"],
    reservedMs = 0,
  ): AudiobookPreservingDecision => ({
    targetPlaylistId: input.targetPlaylistId,
    eligible: reason === "ELIGIBLE",
    reason,
    reservedMs,
  });

  if (env.AUDIOBOOK02_PRESERVING_WRITER_MODE?.trim() !== "ACTIVE") return decision("MODE_OFF");
  const allowlist = new Set(
    (env.AUDIOBOOK02_PRESERVING_WRITER_TARGET_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (!allowlist.has(input.targetPlaylistId)) return decision("TARGET_NOT_ALLOWLISTED");
  if (!input.spotifyPlaylistId) return decision("NO_SPOTIFY_PLAYLIST");
  if (input.updatePolicy === "KEEP_FILLED") return decision("KEEP_FILLED_NOT_SUPPORTED");
  if (!input.libraryProtectedOnly) return decision("OTHER_AUDIOBOOK_PROTECTION");
  if (!input.activeReading) return decision("NO_ACTIVE_READING");
  const remaining = Math.max(
    0,
    Math.trunc(input.activeReading.chapterDurationMs) -
      Math.trunc(input.activeReading.consumedMs),
  );
  return decision("ELIGIBLE", remaining);
}

/**
 * Reserves the chapter's remaining virtual duration from the planning budget,
 * consuming PER_EVENT blocks in order. Mutates the run target in place.
 */
export function reserveAudiobookChapterBudget(target: RunTarget, reservedMs: number): void {
  const reserve = Math.max(0, Math.trunc(reservedMs));
  target.rules = {
    ...target.rules,
    targetDurationMs: Math.max(0, target.rules.targetDurationMs - reserve),
  };
  if (!target.durationBlocks) return;
  let left = reserve;
  target.durationBlocks = target.durationBlocks.map((block): DurationPlanningBlock => {
    if (left <= 0) return block;
    const taken = Math.min(left, Math.max(0, block.targetDurationMs));
    left -= taken;
    return { ...block, targetDurationMs: block.targetDurationMs - taken };
  });
}

const REMOVABLE_URI = /^spotify:(track|episode):[A-Za-z0-9]+$/;

export type PreservingRewritePlan = Readonly<{
  removeUris: string[];
  /** Items the writer must never touch: opaque books and unknown objects. */
  protectedItemCount: number;
  blockedReason: "PLANNED_URI_NOT_REMOVABLE_KIND" | null;
}>;

export function planPreservingRewrite(
  state: Pick<SpotifyTargetPlaylistState, "items">,
  finalUris: readonly string[],
): PreservingRewritePlan {
  const removeUris = new Set<string>();
  let protectedItemCount = 0;
  for (const item of state.items) {
    if (
      item.uri &&
      (item.type === "MUSIC" || item.type === "PODCAST") &&
      REMOVABLE_URI.test(item.uri)
    ) {
      removeUris.add(item.uri);
    } else {
      protectedItemCount += 1;
    }
  }
  const blocked = finalUris.some((uri) => !REMOVABLE_URI.test(uri));
  return {
    removeUris: [...removeUris],
    protectedItemCount,
    blockedReason: blocked ? "PLANNED_URI_NOT_REMOVABLE_KIND" : null,
  };
}

export type PreservingRewriteVerification = Readonly<{
  ok: boolean;
  protectedBefore: number;
  protectedAfter: number;
  managedMatchesPlan: boolean;
}>;

/** After the write, every protected item must remain and the rest must equal the plan. */
export function verifyPreservingRewrite(
  before: PreservingRewritePlan,
  after: Pick<SpotifyTargetPlaylistState, "items">,
  finalUris: readonly string[],
): PreservingRewriteVerification {
  const afterPlan = planPreservingRewrite(after, []);
  const managed = after.items
    .filter((item) => item.uri && REMOVABLE_URI.test(item.uri) &&
      (item.type === "MUSIC" || item.type === "PODCAST"))
    .map((item) => item.uri as string);
  const managedMatchesPlan =
    managed.length === finalUris.length &&
    managed.every((uri, index) => uri === finalUris[index]);
  return {
    ok: afterPlan.protectedItemCount === before.protectedItemCount && managedMatchesPlan,
    protectedBefore: before.protectedItemCount,
    protectedAfter: afterPlan.protectedItemCount,
    managedMatchesPlan,
  };
}
