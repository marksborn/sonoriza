import {
  planRun,
  type Candidate,
  type PlanRunResult,
  type RunTarget,
} from "@/services/playlist-planner";

import type { CompleteMusicDiscoveryProfile } from "./complete-profile";
import {
  buildDiscoveryPlannerMusicPool,
  type DiscoveryPlannerPoolResult,
} from "./planner-bridge";
import {
  buildDiscoveryGate22ScoringReport,
  type DiscoveryGate22ScoringReport,
} from "./scoring-gate2-2";
import type { DiscoveryTrackIdentityEvidence } from "./track-identity";

export type DiscoveryPreviewSourceKind = "MUSIC" | "PODCAST";

export type DiscoveryPreviewSourceBatch = {
  candidates: Candidate[];
  done: boolean;
  fromCache?: boolean;
  unavailableMusicSkippedCount?: number;
};

export type DiscoveryPreviewSource = {
  id: string;
  label: string;
  kind: DiscoveryPreviewSourceKind;
  readonly done: boolean;
  readNext(): Promise<DiscoveryPreviewSourceBatch>;
};

export type DiscoveryPreviewSourceFailure<
  TSource extends DiscoveryPreviewSource = DiscoveryPreviewSource,
> = {
  source: TSource;
  error: unknown;
};

export type CompleteDiscoverySourceUniverse<
  TSource extends DiscoveryPreviewSource = DiscoveryPreviewSource,
> = {
  universe: "COMPLETE";
  music: Candidate[];
  podcasts: Candidate[];
  degradedFailures: DiscoveryPreviewSourceFailure<TSource>[];
  evidence: {
    sourceCount: number;
    musicSourceCount: number;
    podcastSourceCount: number;
    readCalls: number;
    cacheBatchCount: number;
    unavailableMusicSkippedCount: number;
    duplicateMusicUriDroppedCount: number;
    degradedSourceCount: number;
    degradedSources: Array<{
      id: string;
      label: string;
      kind: DiscoveryPreviewSourceKind;
    }>;
    sources: Array<{
      id: string;
      label: string;
      kind: DiscoveryPreviewSourceKind;
      readCalls: number;
      candidateCount: number;
      done: true;
    }>;
  };
};

export type BuildCompleteDiscoveryMusicSelectionInput = {
  profile: CompleteMusicDiscoveryProfile;
  sourceUniverse: CompleteDiscoverySourceUniverse;
  trackIdentities: DiscoveryTrackIdentityEvidence[];
  rediscoveryCeiling?: number;
};

export type CompleteDiscoveryMusicSelection = {
  scoring: DiscoveryGate22ScoringReport;
  plannerPool: DiscoveryPlannerPoolResult;
};

export type BuildCompleteDiscoveryPlannerPreviewInput =
  BuildCompleteDiscoveryMusicSelectionInput & {
    targets: RunTarget[];
    blockedMusicTrackIdsByTargetId?: ReadonlyMap<string, ReadonlySet<string>>;
  };

export type CompleteDiscoveryPlannerPreview = {
  version: "gate3b-preview-v1";
  selectionMode: "PREVIEW_ONLY";
  scoring: DiscoveryGate22ScoringReport;
  plannerPool: DiscoveryPlannerPoolResult;
  plan: PlanRunResult;
  evidence: {
    profileUniverse: "COMPLETE";
    sourceUniverse: "COMPLETE";
    historyArtistCount: number;
    historyTrackCount: number;
    sourceMusicCount: number;
    sourcePodcastCount: number;
    rankedMusicCount: number;
    targetCount: number;
  };
};

const MAX_SOURCE_READ_CALLS = 10_000;

/**
 * Gate 3B deliberately drains every source cursor before planner selection.
 * This is the opposite of the production incremental early-stop path: the
 * preview must prove that candidateUniverse=COMPLETE is factual, not inferred.
 */
export async function collectCompleteDiscoverySourceUniverse<
  TSource extends DiscoveryPreviewSource,
>(
  sources: TSource[],
  options: {
    recoverSourceFailure?: (source: TSource, error: unknown) => boolean;
  } = {},
): Promise<CompleteDiscoverySourceUniverse<TSource>> {
  const rawMusic: Candidate[] = [];
  const podcasts: Candidate[] = [];
  const sourceEvidence: CompleteDiscoverySourceUniverse<TSource>["evidence"]["sources"] = [];
  const degradedFailures: DiscoveryPreviewSourceFailure<TSource>[] = [];
  const recoverSourceFailure = options.recoverSourceFailure ?? (() => false);
  let readCalls = 0;
  let cacheBatchCount = 0;
  let unavailableMusicSkippedCount = 0;

  for (const source of sources) {
    let sourceReadCalls = 0;
    let candidateCount = 0;
    const sourceMusic: Candidate[] = [];
    const sourcePodcasts: Candidate[] = [];

    try {
      while (!source.done) {
        if (readCalls >= MAX_SOURCE_READ_CALLS) {
          throw new Error(
            `DISCOVERY Gate 3B source collection exceeded ${MAX_SOURCE_READ_CALLS} read calls before every cursor completed`,
          );
        }

        const batch = await source.readNext();
        readCalls += 1;
        sourceReadCalls += 1;
        candidateCount += batch.candidates.length;
        if (batch.fromCache) cacheBatchCount += 1;
        unavailableMusicSkippedCount += batch.unavailableMusicSkippedCount ?? 0;

        if (source.kind === "MUSIC") sourceMusic.push(...batch.candidates);
        else sourcePodcasts.push(...batch.candidates);

        if (batch.done && !source.done) {
          throw new Error(
            `DISCOVERY Gate 3B source ${source.id} reported batch.done=true while its cursor remained open`,
          );
        }
      }
    } catch (error) {
      if (!recoverSourceFailure(source, error)) throw error;
      degradedFailures.push({ source, error });
      continue;
    }

    // Commit candidates only after the source cursor completes. This makes a
    // recovered 502 atomic: pages read before the failure never enter ranking.
    rawMusic.push(...sourceMusic);
    podcasts.push(...sourcePodcasts);
    sourceEvidence.push({
      id: source.id,
      label: source.label,
      kind: source.kind,
      readCalls: sourceReadCalls,
      candidateCount,
      done: true,
    });
  }

  const dedupedMusic = dedupeMusicByUri(rawMusic);

  return {
    universe: "COMPLETE",
    music: dedupedMusic.candidates,
    podcasts,
    degradedFailures,
    evidence: {
      sourceCount: sources.length,
      musicSourceCount: sources.filter((source) => source.kind === "MUSIC").length,
      podcastSourceCount: sources.filter((source) => source.kind === "PODCAST").length,
      readCalls,
      cacheBatchCount,
      unavailableMusicSkippedCount,
      duplicateMusicUriDroppedCount: dedupedMusic.droppedCount,
      degradedSourceCount: degradedFailures.length,
      degradedSources: degradedFailures.map(({ source }) => ({
        id: source.id,
        label: source.label,
        kind: source.kind,
      })),
      sources: sourceEvidence,
    },
  };
}

/** Complete historical facts + complete source MUSIC -> Gate 2.2 -> Gate 3A. */
export function buildCompleteDiscoveryMusicSelection(
  input: BuildCompleteDiscoveryMusicSelectionInput,
): CompleteDiscoveryMusicSelection {
  if (input.profile.universe !== "COMPLETE") {
    throw new Error("DISCOVERY requires a COMPLETE historical profile universe");
  }
  if (input.sourceUniverse.universe !== "COMPLETE") {
    throw new Error("DISCOVERY requires a COMPLETE source MUSIC universe");
  }

  const scoreTopN = Math.max(
    1,
    input.profile.artists.length,
    input.profile.tracks.length,
  );
  const profile = input.profile.profile;
  const scoring = buildDiscoveryGate22ScoringReport({
    generatedAt: profile.generatedAt,
    dormantDays: profile.heuristics.dormantDays,
    rediscoveryGapDays: profile.heuristics.rediscoveryGapDays,
    topN: scoreTopN,
    artists: input.profile.artists,
    tracks: input.profile.tracks,
    trackIdentities: input.trackIdentities,
    candidateUniverse: "COMPLETE",
  });

  const plannerPool = buildDiscoveryPlannerMusicPool({
    report: scoring,
    music: input.sourceUniverse.music,
    trackIdentities: input.trackIdentities,
    rediscoveryCeiling: input.rediscoveryCeiling,
  });

  return { scoring, plannerPool };
}

/**
 * Complete historical facts + complete source candidates -> Gate 2.2 score ->
 * Gate 3A ranking bridge -> the existing planRun implementation.
 */
export function buildCompleteDiscoveryPlannerPreview(
  input: BuildCompleteDiscoveryPlannerPreviewInput,
): CompleteDiscoveryPlannerPreview {
  const selection = buildCompleteDiscoveryMusicSelection(input);
  const plan = planRun({
    pools: {
      music: selection.plannerPool.music,
      podcasts: input.sourceUniverse.podcasts,
    },
    targets: input.targets,
    blockedMusicTrackIdsByTargetId: input.blockedMusicTrackIdsByTargetId,
  });

  return {
    version: "gate3b-preview-v1",
    selectionMode: "PREVIEW_ONLY",
    scoring: selection.scoring,
    plannerPool: selection.plannerPool,
    plan,
    evidence: {
      profileUniverse: input.profile.universe,
      sourceUniverse: input.sourceUniverse.universe,
      historyArtistCount: input.profile.artists.length,
      historyTrackCount: input.profile.tracks.length,
      sourceMusicCount: input.sourceUniverse.music.length,
      sourcePodcastCount: input.sourceUniverse.podcasts.length,
      rankedMusicCount: selection.plannerPool.music.length,
      targetCount: input.targets.length,
    },
  };
}

function dedupeMusicByUri(input: Candidate[]): {
  candidates: Candidate[];
  droppedCount: number;
} {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let droppedCount = 0;

  for (const candidate of input) {
    if (seen.has(candidate.uri)) {
      droppedCount += 1;
      continue;
    }
    seen.add(candidate.uri);
    candidates.push(candidate);
  }

  return { candidates, droppedCount };
}
