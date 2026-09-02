import { AsyncLocalStorage } from "node:async_hooks";

import type { RequiredPolicyUsesEvaluation } from "@/services/data-policy";
import {
  applyFirstPartyPlaybackPreferencesToMusicCandidates,
  type FirstPartyPlaybackPreference,
  type FirstPartyPlannerPreferenceEvidence,
} from "@/services/music-preference";
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
  /** Gate 5C capability decision for Spotify Recently Played planner use. */
  repeatCompliance: RequiredPolicyUsesEvaluation;
  recentlyPlayedSkippedCount: number;
  missingTrackIdentitySkippedCount: number;
  preWriteSync: RecentlyPlayedSyncResult | null;
  preWriteRevalidated: boolean;
  preWriteBlockedCount: number;
  preWriteMissingIdentityCount: number;
  /** Gate 5B: authoritative explicit Sonoriza preferences for this run. */
  firstPartyPlaybackPreferences: readonly FirstPartyPlaybackPreference[];
  /** Latest deterministic application evidence; raw subject keys are not logged. */
  firstPartyPreferenceEvidence: FirstPartyPlannerPreferenceEvidence | null;
  /** SOURCE-LIKED-01 Gate 3B: observability only, never authoritative planner input. */
  likedTrackSourceShadow?: Record<string, unknown> | null;
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

  // Gate 5C: Spotify Recently Played only affects planner eligibility when the
  // central capability matrix explicitly ALLOWs every required use. The current
  // matrix is REVIEW_REQUIRED, so the productive path is a no-op instead of
  // silently treating the historical cooldown projection as first-party.
  const repeatFiltered = state.repeatCompliance.allowed
    ? filterMusicCandidatesForRepeat(candidates, state.context)
    : {
        candidates,
        recentlyPlayedSkippedCount: 0,
        missingTrackIdentitySkippedCount: 0,
      };
  state.recentlyPlayedSkippedCount += repeatFiltered.recentlyPlayedSkippedCount;
  state.missingTrackIdentitySkippedCount +=
    repeatFiltered.missingTrackIdentitySkippedCount;

  const firstParty = applyFirstPartyPlaybackPreferencesToMusicCandidates(
    repeatFiltered.candidates,
    state.firstPartyPlaybackPreferences,
  );
  state.firstPartyPreferenceEvidence = firstParty.evidence;

  return {
    candidates: firstParty.candidates,
    recentlyPlayedSkippedCount: repeatFiltered.recentlyPlayedSkippedCount,
    missingTrackIdentitySkippedCount:
      repeatFiltered.missingTrackIdentitySkippedCount,
  };
}

/**
 * Called after the final plan has been computed but before it is returned to
 * the generator. Gate 5C keeps the old revalidation implementation behind the
 * same central capability decision. Under the current matrix the Spotify
 * Recently Played re-sync is not performed and cannot veto a plan.
 */
export async function revalidateMusicRepeatBeforeRealWrite(
  plan: PlanRunResult,
): Promise<void> {
  const state = currentMusicRepeatState();

  if (
    state &&
    state.repeatCompliance.allowed &&
    !state.simulate &&
    state.context.enabled
  ) {
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
