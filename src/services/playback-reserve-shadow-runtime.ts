import { AsyncLocalStorage } from "node:async_hooks";

import { prisma } from "@/lib/prisma";
import {
  loadEffectivePlaybackReservePolicy,
  type EffectivePlaybackReservePolicySnapshot,
} from "@/services/playback-reserve-policy";
import type { PlaybackReserveRunShadowEvidence } from "@/services/playlist-planner/plan-run-playback-reserve";

export type PlaybackReserveShadowRuntimeState = {
  gate: 5;
  mode: "SHADOW";
  plannerInfluence: false;
  spotifyWriteInfluence: false;
  additionalProviderReads: false;
  policies: ReadonlyMap<string, EffectivePlaybackReservePolicySnapshot>;
  evidence: PlaybackReserveRunShadowEvidence | null;
};

const storage = new AsyncLocalStorage<PlaybackReserveShadowRuntimeState>();

export async function preparePlaybackReserveShadowRuntime(input: {
  userId: string;
  targetPlaylistIds?: readonly string[];
}): Promise<PlaybackReserveShadowRuntimeState> {
  const targetPlaylistIds = input.targetPlaylistIds
    ? [...new Set(input.targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : (
        await prisma.targetPlaylist.findMany({
          where: { userId: input.userId, enabled: true },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          select: { id: true },
        })
      ).map((target) => target.id);

  const policies = await Promise.all(
    targetPlaylistIds.map(async (targetPlaylistId) => [
      targetPlaylistId,
      await loadEffectivePlaybackReservePolicy(input.userId, targetPlaylistId),
    ] as const),
  );

  return {
    gate: 5,
    mode: "SHADOW",
    plannerInfluence: false,
    spotifyWriteInfluence: false,
    additionalProviderReads: false,
    policies: new Map(policies),
    evidence: null,
  };
}

export function runWithPlaybackReserveShadowRuntimeState<T>(
  state: PlaybackReserveShadowRuntimeState,
  fn: () => T,
): T {
  return storage.run(state, fn);
}

export function currentPlaybackReserveShadowRuntimeState():
  | PlaybackReserveShadowRuntimeState
  | null {
  return storage.getStore() ?? null;
}

export function recordPlaybackReserveShadowEvidence(
  evidence: PlaybackReserveRunShadowEvidence,
): void {
  const state = storage.getStore();
  if (!state) return;
  state.evidence = evidence;
}

export function playbackReserveShadowRuntimeSummary(
  state: PlaybackReserveShadowRuntimeState,
) {
  return state.evidence ?? {
    gate: 5 as const,
    mode: "SHADOW" as const,
    plannerInfluence: false as const,
    spotifyWriteInfluence: false as const,
    additionalProviderReads: false as const,
    status: "NO_PLAN_CAPTURED" as const,
    targetCount: 0,
    readyTargetCount: 0,
    shortfallTargetCount: 0,
    targets: [],
  };
}
