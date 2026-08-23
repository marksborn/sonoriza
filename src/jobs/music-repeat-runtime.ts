import { AsyncLocalStorage } from "node:async_hooks";

import type { Candidate, PlanRunResult } from "@/services/playlist-planner";
import {
  filterMusicCandidatesForRepeat,
  refreshMusicRepeatContext,
  type MusicRepeatContext,
  type RecentlyPlayedSyncResult,
} from "@/services/spotify/recently-played";

import { revalidateTargetDiscoveryPoliciesBeforeRealWrite } from "./target-discovery-runtime";

export class MusicRepeatPreWriteBlockedError extends Error {
  readonly blockedCount: number;
  readonly missingIdentityCount: number;

  constructor(blockedCount: number, missingIdentityCount: number) {
    super(
      "A geração foi bloqueada antes de alterar o Spotify porque o histórico de reprodução mudou durante o planejamento.",
    );
    this.name = "MusicRepeatPreWriteBlockedError";
    this.blockedCount = blockedCount;
    this.missingIdentityCount = missingIdentityCount;
  }
}

export type MusicRepeatRunState = {
  userId: string;
  simulate: boolean;
  context: MusicRepeatContext;
  initialSync: RecentlyPlayedSyncResult;
  recentlyPlayedSkippedCount: number;
  missingTrackIdentitySkippedCount: number;
  preWriteSync: RecentlyPlayedSyncResult | null;
  preWriteRevalidated: boolean;
  preWriteBlockedCount: number;
  preWriteMissingIdentityCount: number;
};

const storage = new AsyncLocalStorage<MusicRepeatRunState>();

export function runWithMusicRepeatState<T>(
  state: MusicRepeatRunState,
  run: () => Promise<T>,
): Promise<T> {
  return storage.run(state, run);
}

export function currentMusicRepeatState(): MusicRepeatRunState | null {
  return storage.getStore() ?? null;
}

export function filterMusicBatchForCurrentRun(candidates: Candidate[]): {
  candidates: Candidate[];
  recentlyPlayedSkippedCount: number;
  missingTrackIdentitySkippedCount: number;
} {
  const state = currentMusicRepeatState();
  if (!state) {
    return {
      candidates,
      recentlyPlayedSkippedCount: 0,
      missingTrackIdentitySkippedCount: 0,
    };
  }

  const filtered = filterMusicCandidatesForRepeat(candidates, state.context);
  state.recentlyPlayedSkippedCount += filtered.recentlyPlayedSkippedCount;
  state.missingTrackIdentitySkippedCount += filtered.missingTrackIdentitySkippedCount;
  return filtered;
}

/**
 * Called after the final plan has been computed but before it is returned to
 * the generator. A real run re-syncs Spotify here and rejects a plan that
 * became stale while collection/planning was in progress. DISCOVER-DEST-01
 * also revalidates the per-target discovery policy through an independent
 * runtime context. Because the writer is created only after this returns, a
 * rejection causes zero Spotify playlist writes.
 */
export async function revalidateMusicRepeatBeforeRealWrite(
  plan: PlanRunResult,
): Promise<void> {
  const state = currentMusicRepeatState();

  if (state && !state.simulate && state.context.enabled) {
    const refreshed = await refreshMusicRepeatContext(state.userId, new Date());
    state.preWriteSync = refreshed.sync;
    state.context = refreshed.context;
    state.preWriteRevalidated = true;

    let blockedCount = 0;
    let missingIdentityCount = 0;
    for (const target of plan.targets) {
      for (const item of target.result.items) {
        if (item.type !== "MUSIC") continue;
        if (!item.spotifyTrackId) {
          missingIdentityCount += 1;
          continue;
        }
        if (refreshed.context.blockedTrackIds.has(item.spotifyTrackId)) {
          blockedCount += 1;
        }
      }
    }

    state.preWriteBlockedCount = blockedCount;
    state.preWriteMissingIdentityCount = missingIdentityCount;
    if (blockedCount > 0 || missingIdentityCount > 0) {
      throw new MusicRepeatPreWriteBlockedError(blockedCount, missingIdentityCount);
    }
  }

  await revalidateTargetDiscoveryPoliciesBeforeRealWrite();
}
