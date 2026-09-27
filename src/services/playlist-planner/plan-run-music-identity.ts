import {
  applyGate4E1CanonicalDedupeToMusicCandidates,
  captureGate4E1PlannerComparison,
  currentGate4E1RuntimeState,
  gate4E1PlannerInfluencedTarget,
} from "@/services/music-identity/canonical-dedupe-runtime";

import {
  planRun as basePlanRun,
  type PlanRunInput,
  type PlanRunResult,
} from "./plan-run-calendar03";
import type { Candidate } from "./types";

export type {
  PlanRunInput,
  PlanRunResult,
  PlanRunTargetResult,
  RunTarget,
} from "./plan-run-calendar03";

/**
 * MUSIC-IDENTITY-01 Gate 4E1 controlled pre-planner seam.
 *
 * The durable projection is prepared before generation and stored in the
 * AsyncLocalStorage runtime. This seam is therefore pure/in-memory: it performs
 * no database/provider access and never builds/recomputes canonical identity.
 *
 * Canonical dedupe is applied only after target source scope and current
 * target-local music blockers. Preserved remote items and podcasts are never
 * rewritten. OFF or any abstention delegates byte-for-byte to the legacy input.
 */
export function planRun(input: PlanRunInput): PlanRunResult {
  const state = currentGate4E1RuntimeState();
  if (!state || state.effectiveMode !== "ACTIVE") return basePlanRun(input);

  const musicPoolByTargetId = new Map<string, Candidate[]>();
  for (const target of input.targets) {
    const sourceScoped = filterConfiguredSourceCandidates(
      input.musicPoolByTargetId?.get(target.targetPlaylistId) ?? input.pools.music,
      input.sourceIdsByTargetId?.get(target.targetPlaylistId),
    );
    const blocked = input.blockedMusicTrackIdsByTargetId?.get(target.targetPlaylistId);
    const eligible =
      blocked && blocked.size > 0
        ? sourceScoped.filter(
            (candidate) =>
              candidate.type !== "MUSIC" ||
              !candidate.spotifyTrackId ||
              !blocked.has(candidate.spotifyTrackId),
          )
        : sourceScoped;

    musicPoolByTargetId.set(
      target.targetPlaylistId,
      applyGate4E1CanonicalDedupeToMusicCandidates({
        targetPlaylistId: target.targetPlaylistId,
        candidates: eligible,
      }),
    );
  }

  const influencedTargetIds = input.targets
    .map((target) => target.targetPlaylistId)
    .filter(gate4E1PlannerInfluencedTarget);
  if (influencedTargetIds.length === 0) return basePlanRun(input);

  // Same-execution legacy shadow. It is discarded productively and exists only
  // for Gate 4E1 comparison/rollback evidence. The second call is authoritative.
  const legacy = basePlanRun(input);
  const canonical = basePlanRun({
    ...input,
    musicPoolByTargetId,
  });

  const legacyByTargetId = new Map(
    legacy.targets.map((target) => [target.targetPlaylistId, target.result] as const),
  );
  const canonicalByTargetId = new Map(
    canonical.targets.map((target) => [target.targetPlaylistId, target.result] as const),
  );
  for (const targetPlaylistId of influencedTargetIds) {
    const legacyResult = legacyByTargetId.get(targetPlaylistId);
    const canonicalResult = canonicalByTargetId.get(targetPlaylistId);
    if (!legacyResult || !canonicalResult) continue;
    captureGate4E1PlannerComparison({
      targetPlaylistId,
      legacy: legacyResult,
      canonical: canonicalResult,
    });
  }

  return canonical;
}

function filterConfiguredSourceCandidates(
  candidates: readonly Candidate[],
  allowedSourceIds: ReadonlySet<string> | undefined,
): Candidate[] {
  if (!allowedSourceIds) return [...candidates];
  return candidates.filter((candidate) => {
    if (!candidate.sourcePlaylistId) return true;
    return allowedSourceIds.has(candidate.sourcePlaylistId);
  });
}
