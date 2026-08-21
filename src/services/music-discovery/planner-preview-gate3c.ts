import {
  collectIncrementally,
  type IncrementalCandidateSource,
  type IncrementalPlanningResult,
} from "@/jobs/incremental-planning";
import type { Candidate, RunTarget } from "@/services/playlist-planner";

import type { CompleteMusicDiscoveryProfile } from "./complete-profile";
import {
  buildCompleteDiscoveryPlannerPreview,
  collectCompleteDiscoverySourceUniverse,
  type CompleteDiscoveryPlannerPreview,
  type CompleteDiscoverySourceUniverse,
  type DiscoveryPreviewSource,
} from "./planner-preview";
import type { DiscoveryTrackIdentityEvidence } from "./track-identity";

export const DISCOVERY_GATE3D_SEQUENCE_TERMINAL_UNDERFILL_TOLERANCE_MS = 30_000;

export type Gate3CMusicUniverse = {
  universe: "MUSIC_COMPLETE";
  sourceUniverse: CompleteDiscoverySourceUniverse;
  ignoredPodcastSourceCount: number;
};

export type Gate3CPodcastEvidence = {
  policyVersion: "gate3d-podcast-read-v1";
  replanAfterEachSourceRead: true;
  sequenceTerminalUnderfillToleranceMs: number;
  sourceCount: number;
  readSourceCount: number;
  attemptedSourceCount: number;
  readCalls: number;
  candidateCount: number;
  stoppedEarly: boolean;
  doneSourceCount: number;
  remainingSourceCount: number;
  sources: Array<{
    id: string;
    label: string;
    readCalls: number;
    candidateCount: number;
    done: boolean;
  }>;
};

export type Gate3CPlannerPreview = {
  version: "gate3d-preview-v1";
  selectionMode: "PREVIEW_ONLY";
  selection: CompleteDiscoveryPlannerPreview;
  incremental: IncrementalPlanningResult<IncrementalCandidateSource>;
  podcastEvidence: Gate3CPodcastEvidence;
};

export async function collectCompleteDiscoveryMusicUniverse(
  sources: DiscoveryPreviewSource[],
): Promise<Gate3CMusicUniverse> {
  const musicSources = sources.filter((source) => source.kind === "MUSIC");
  const ignoredPodcastSourceCount = sources.length - musicSources.length;
  const sourceUniverse = await collectCompleteDiscoverySourceUniverse(musicSources);

  if (sourceUniverse.podcasts.length !== 0) {
    throw new Error("DISCOVERY Gate 3C music universe unexpectedly collected podcast candidates");
  }
  if (!sourceUniverse.evidence.sources.every((source) => source.done)) {
    throw new Error("DISCOVERY Gate 3C requires every MUSIC source cursor to be exhausted");
  }

  return {
    universe: "MUSIC_COMPLETE",
    sourceUniverse,
    ignoredPodcastSourceCount,
  };
}

export async function buildGate3CHybridPlannerPreview(input: {
  profile: CompleteMusicDiscoveryProfile;
  musicUniverse: Gate3CMusicUniverse;
  trackIdentities: DiscoveryTrackIdentityEvidence[];
  targets: RunTarget[];
  podcastSources: IncrementalCandidateSource[];
  blockedMusicTrackIdsByTargetId?: ReadonlyMap<string, ReadonlySet<string>>;
  rediscoveryCeiling?: number;
}): Promise<Gate3CPlannerPreview> {
  if (input.musicUniverse.universe !== "MUSIC_COMPLETE") {
    throw new Error("DISCOVERY Gate 3C requires a complete MUSIC source universe");
  }
  if (input.podcastSources.some((source) => source.kind !== "PODCAST")) {
    throw new Error("DISCOVERY Gate 3C incremental sources must be PODCAST-only");
  }

  // Reuse the already-certified Gate 3B scoring + bridge with a source universe
  // that is complete for MUSIC and intentionally empty for PODCAST. Its plan is
  // not used; Gate 3D feeds the ranked music pool into the existing incremental
  // collector while opting into source-level replanning and a bounded terminal
  // SEQUENCE underfill tolerance. Default production collector behavior remains
  // unchanged until DISCOVERY is explicitly activated there.
  const selection = buildCompleteDiscoveryPlannerPreview({
    profile: input.profile,
    sourceUniverse: input.musicUniverse.sourceUniverse,
    trackIdentities: input.trackIdentities,
    targets: input.targets,
    blockedMusicTrackIdsByTargetId: input.blockedMusicTrackIdsByTargetId,
    rediscoveryCeiling: input.rediscoveryCeiling,
  });

  const rankedMusicSource = createRankedMusicMemorySource(selection.plannerPool.music);
  const podcastReadStats = new Map<string, { readCalls: number; candidateCount: number }>();

  const incremental = await collectIncrementally({
    sources: [rankedMusicSource, ...input.podcastSources],
    targets: input.targets,
    blockedMusicTrackIdsByTargetId: input.blockedMusicTrackIdsByTargetId,
    replanAfterEachSourceRead: true,
    sequenceTerminalUnderfillToleranceMs:
      DISCOVERY_GATE3D_SEQUENCE_TERMINAL_UNDERFILL_TOLERANCE_MS,
    // Preview never performs a pre-write Spotify revalidation because it never
    // reaches a writer. MUSIC-01 was already applied before scoring the pool.
    revalidateBeforeWrite: async () => undefined,
    onBatch(source, batch) {
      if (source.kind !== "PODCAST") return;
      const current = podcastReadStats.get(source.id) ?? { readCalls: 0, candidateCount: 0 };
      current.readCalls += 1;
      current.candidateCount += batch.candidates.length;
      podcastReadStats.set(source.id, current);
    },
  });

  const podcastEvidenceSources = input.podcastSources.map((source) => {
    const read = podcastReadStats.get(source.id) ?? { readCalls: 0, candidateCount: 0 };
    return {
      id: source.id,
      label: source.label,
      readCalls: read.readCalls,
      candidateCount: read.candidateCount,
      done: source.done,
    };
  });

  return {
    version: "gate3d-preview-v1",
    selectionMode: "PREVIEW_ONLY",
    selection,
    incremental,
    podcastEvidence: {
      policyVersion: "gate3d-podcast-read-v1",
      replanAfterEachSourceRead: true,
      sequenceTerminalUnderfillToleranceMs:
        DISCOVERY_GATE3D_SEQUENCE_TERMINAL_UNDERFILL_TOLERANCE_MS,
      sourceCount: input.podcastSources.length,
      readSourceCount:
        incremental.readSourceIds.size -
        (incremental.readSourceIds.has(rankedMusicSource.id) ? 1 : 0),
      attemptedSourceCount:
        incremental.attemptedSourceIds.size -
        (incremental.attemptedSourceIds.has(rankedMusicSource.id) ? 1 : 0),
      readCalls: podcastEvidenceSources.reduce((sum, source) => sum + source.readCalls, 0),
      candidateCount: podcastEvidenceSources.reduce(
        (sum, source) => sum + source.candidateCount,
        0,
      ),
      stoppedEarly: input.podcastSources.some((source) => !source.done),
      doneSourceCount: podcastEvidenceSources.filter((source) => source.done).length,
      remainingSourceCount: podcastEvidenceSources.filter((source) => !source.done).length,
      sources: podcastEvidenceSources,
    },
  };
}

function createRankedMusicMemorySource(
  candidates: Candidate[],
): IncrementalCandidateSource {
  let done = false;
  return {
    id: "DISCOVERY:GATE3C:RANKED_MUSIC",
    label: "DISCOVERY ranked MUSIC universe",
    kind: "MUSIC",
    get done() {
      return done;
    },
    async readNext() {
      if (done) return { candidates: [], done: true };
      done = true;
      return { candidates, done: true };
    },
  };
}
