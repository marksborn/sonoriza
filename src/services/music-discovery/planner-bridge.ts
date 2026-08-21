import type { Candidate } from "@/services/playlist-planner";

import {
  recordingIdentityMatchSource,
  type DiscoveryGate22ScoringReport,
  type DiscoveryGate22TrackCandidate,
  type RecordingIdentityMatchSource,
} from "./scoring-gate2-2";
import { assertDiscoverySelectionReady } from "./scoring";
import type { DiscoveryTrackIdentityEvidence } from "./track-identity";

export const DISCOVERY_PLANNER_PREVIEW_POLICY_V1 = {
  version: "planner-gate3-preview-v1",
  rediscoveryCeiling: 0.25,
  budgetRule: "PREFIX_CEILING_WITH_EXHAUSTION_FALLBACK",
  note:
    "Preview-only policy. REDESCOBERTA may occupy at most 25% of a selectable prefix while non-rediscovery alternatives exist; unused capacity returns automatically to FAMILIAR/source fallback. This is calibration, not a final product percentage.",
} as const;

export type DiscoveryPlannerCategory =
  | "REDESCOBERTA"
  | "FAMILIAR"
  | "SOURCE_FALLBACK";

export type DiscoveryPlannerMatchSource =
  | "SPOTIFY_TRACK_ID"
  | RecordingIdentityMatchSource
  | "NONE";

export type DiscoveryPlannerPoolEntry = {
  candidate: Candidate;
  category: DiscoveryPlannerCategory;
  score: number | null;
  matchSource: DiscoveryPlannerMatchSource;
  matchedScoreTrackId: string | null;
  originalIndex: number;
};

export type DiscoveryPlannerPoolResult = {
  music: Candidate[];
  entries: DiscoveryPlannerPoolEntry[];
  evidence: {
    policyVersion: typeof DISCOVERY_PLANNER_PREVIEW_POLICY_V1.version;
    candidateUniverse: "COMPLETE";
    inputCount: number;
    outputCount: number;
    duplicateRecordingDroppedCount: number;
    rediscoveryCount: number;
    familiarCount: number;
    sourceFallbackCount: number;
    crossReleaseMatchedCount: number;
    rediscoveryCeiling: number;
    rediscoveryCeilingRelaxedCount: number;
  };
};

export type BuildDiscoveryPlannerPoolInput = {
  report: DiscoveryGate22ScoringReport;
  music: Candidate[];
  trackIdentities: DiscoveryTrackIdentityEvidence[];
  rediscoveryCeiling?: number;
};

type MatchableTrack = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  evidence: DiscoveryTrackIdentityEvidence | null;
};

type ClassifiedEntry = DiscoveryPlannerPoolEntry & {
  matchable: MatchableTrack | null;
};

/**
 * Gate 3 planner bridge.
 *
 * This does not create a second planner. It turns a COMPLETE Gate 2.2 score
 * report plus the complete source MUSIC pool into a deterministic Candidate[]
 * ordered for the existing playlist planner, whose selection rule is already
 * "first eligible candidate in pool order".
 *
 * ORDER-01 remains downstream: it may reorder MUSIC identities after selection,
 * but it does not change which tracks DISCOVERY made eligible/preferred.
 */
export function buildDiscoveryPlannerMusicPool(
  input: BuildDiscoveryPlannerPoolInput,
): DiscoveryPlannerPoolResult {
  assertDiscoverySelectionReady(input.report);
  if (input.report.selectionPolicy.candidateUniverse !== "COMPLETE") {
    throw new Error("DISCOVERY planner bridge requires candidateUniverse=COMPLETE");
  }

  const rediscoveryCeiling = normalizeCeiling(
    input.rediscoveryCeiling ??
      DISCOVERY_PLANNER_PREVIEW_POLICY_V1.rediscoveryCeiling,
  );
  const identityByTrackId = new Map(
    input.trackIdentities.map((row) => [row.spotifyTrackId, row] as const),
  );
  const rediscoveryById = new Map(
    input.report.rediscoveryCandidates.map((row) => [row.spotifyTrackId, row] as const),
  );
  const familiarById = new Map(
    input.report.familiarCandidates.map((row) => [row.spotifyTrackId, row] as const),
  );

  const rediscovery = input.report.rediscoveryCandidates;
  const familiar = input.report.familiarCandidates;
  const classified = input.music.map((candidate, originalIndex) =>
    classifyCandidate({
      candidate,
      originalIndex,
      identityByTrackId,
      rediscovery,
      familiar,
      rediscoveryById,
      familiarById,
    }),
  );

  const orderedWithinCategory = {
    REDESCOBERTA: classified
      .filter((entry) => entry.category === "REDESCOBERTA")
      .sort(byScoreThenSourceOrder),
    FAMILIAR: classified
      .filter((entry) => entry.category === "FAMILIAR")
      .sort(byScoreThenSourceOrder),
    SOURCE_FALLBACK: classified
      .filter((entry) => entry.category === "SOURCE_FALLBACK")
      .sort((a, b) => a.originalIndex - b.originalIndex),
  } satisfies Record<DiscoveryPlannerCategory, ClassifiedEntry[]>;

  const nonRediscovery = [
    ...orderedWithinCategory.FAMILIAR,
    ...orderedWithinCategory.SOURCE_FALLBACK,
  ];
  const interleaved = interleaveWithRediscoveryCeiling(
    orderedWithinCategory.REDESCOBERTA,
    nonRediscovery,
    rediscoveryCeiling,
  );
  const deduped = dedupeRecordingIdentity(interleaved, identityByTrackId);

  const rediscoveryCount = deduped.entries.filter(
    (entry) => entry.category === "REDESCOBERTA",
  ).length;
  const familiarCount = deduped.entries.filter(
    (entry) => entry.category === "FAMILIAR",
  ).length;
  const sourceFallbackCount = deduped.entries.filter(
    (entry) => entry.category === "SOURCE_FALLBACK",
  ).length;
  const crossReleaseMatchedCount = deduped.entries.filter(
    (entry) =>
      entry.matchSource !== "NONE" && entry.matchSource !== "SPOTIFY_TRACK_ID",
  ).length;

  return {
    music: deduped.entries.map((entry) => entry.candidate),
    entries: deduped.entries.map(({ matchable: _matchable, ...entry }) => entry),
    evidence: {
      policyVersion: DISCOVERY_PLANNER_PREVIEW_POLICY_V1.version,
      candidateUniverse: "COMPLETE",
      inputCount: input.music.length,
      outputCount: deduped.entries.length,
      duplicateRecordingDroppedCount: deduped.droppedCount,
      rediscoveryCount,
      familiarCount,
      sourceFallbackCount,
      crossReleaseMatchedCount,
      rediscoveryCeiling,
      rediscoveryCeilingRelaxedCount: interleaved.ceilingRelaxedCount,
    },
  };
}

function classifyCandidate(input: {
  candidate: Candidate;
  originalIndex: number;
  identityByTrackId: Map<string, DiscoveryTrackIdentityEvidence>;
  rediscovery: DiscoveryGate22TrackCandidate[];
  familiar: DiscoveryGate22TrackCandidate[];
  rediscoveryById: Map<string, DiscoveryGate22TrackCandidate>;
  familiarById: Map<string, DiscoveryGate22TrackCandidate>;
}): ClassifiedEntry {
  const trackId = input.candidate.spotifyTrackId?.trim() || null;
  const matchable = toMatchableTrack(input.candidate, input.identityByTrackId);

  if (trackId) {
    const directRediscovery = input.rediscoveryById.get(trackId);
    if (directRediscovery) {
      return entryFromMatch(
        input.candidate,
        input.originalIndex,
        matchable,
        "REDESCOBERTA",
        directRediscovery,
        "SPOTIFY_TRACK_ID",
      );
    }
    const directFamiliar = input.familiarById.get(trackId);
    if (directFamiliar) {
      return entryFromMatch(
        input.candidate,
        input.originalIndex,
        matchable,
        "FAMILIAR",
        directFamiliar,
        "SPOTIFY_TRACK_ID",
      );
    }
  }

  if (matchable) {
    const rediscoveryMatch = findCrossReleaseMatch(
      matchable,
      input.rediscovery,
      input.identityByTrackId,
    );
    if (rediscoveryMatch) {
      return entryFromMatch(
        input.candidate,
        input.originalIndex,
        matchable,
        "REDESCOBERTA",
        rediscoveryMatch.row,
        rediscoveryMatch.source,
      );
    }

    const familiarMatch = findCrossReleaseMatch(
      matchable,
      input.familiar,
      input.identityByTrackId,
    );
    if (familiarMatch) {
      return entryFromMatch(
        input.candidate,
        input.originalIndex,
        matchable,
        "FAMILIAR",
        familiarMatch.row,
        familiarMatch.source,
      );
    }
  }

  return {
    candidate: input.candidate,
    category: "SOURCE_FALLBACK",
    score: null,
    matchSource: "NONE",
    matchedScoreTrackId: null,
    originalIndex: input.originalIndex,
    matchable,
  };
}

function entryFromMatch(
  candidate: Candidate,
  originalIndex: number,
  matchable: MatchableTrack | null,
  category: "REDESCOBERTA" | "FAMILIAR",
  row: DiscoveryGate22TrackCandidate,
  matchSource: Exclude<DiscoveryPlannerMatchSource, "NONE">,
): ClassifiedEntry {
  return {
    candidate,
    category,
    score: row.score,
    matchSource,
    matchedScoreTrackId: row.spotifyTrackId,
    originalIndex,
    matchable,
  };
}

function findCrossReleaseMatch(
  source: MatchableTrack,
  scored: DiscoveryGate22TrackCandidate[],
  identityByTrackId: Map<string, DiscoveryTrackIdentityEvidence>,
): { row: DiscoveryGate22TrackCandidate; source: RecordingIdentityMatchSource } | null {
  for (const row of scored) {
    const match = recordingIdentityMatchSource(source, {
      spotifyTrackId: row.spotifyTrackId,
      trackName: row.trackName,
      artistName: row.artistName,
      evidence: identityByTrackId.get(row.spotifyTrackId) ?? null,
    });
    if (match) return { row, source: match };
  }
  return null;
}

function toMatchableTrack(
  candidate: Candidate,
  identityByTrackId: Map<string, DiscoveryTrackIdentityEvidence>,
): MatchableTrack | null {
  const spotifyTrackId = candidate.spotifyTrackId?.trim();
  if (!spotifyTrackId || candidate.type !== "MUSIC") return null;
  const stored = identityByTrackId.get(spotifyTrackId);
  const primaryArtistId =
    stored?.primaryArtistId ?? candidate.primaryArtistId?.trim() ?? null;
  return {
    spotifyTrackId,
    trackName: candidate.title,
    artistName: candidate.primaryArtistName ?? candidate.subtitle ?? "",
    evidence: stored
      ? {
          ...stored,
          primaryArtistId,
        }
      : {
          spotifyTrackId,
          isrc: null,
          primaryArtistId,
          isrcConflict: false,
          primaryArtistIdConflict: false,
        },
  };
}

function byScoreThenSourceOrder(a: ClassifiedEntry, b: ClassifiedEntry): number {
  return (b.score ?? -1) - (a.score ?? -1) || a.originalIndex - b.originalIndex;
}

function interleaveWithRediscoveryCeiling(
  rediscovery: ClassifiedEntry[],
  nonRediscovery: ClassifiedEntry[],
  ceiling: number,
): { entries: ClassifiedEntry[]; ceilingRelaxedCount: number } {
  const out: ClassifiedEntry[] = [];
  let rediscoveryIndex = 0;
  let nonRediscoveryIndex = 0;
  let rediscoverySelected = 0;
  let ceilingRelaxedCount = 0;

  while (
    rediscoveryIndex < rediscovery.length ||
    nonRediscoveryIndex < nonRediscovery.length
  ) {
    const nextPosition = out.length + 1;
    const mayTakeRediscovery =
      rediscoveryIndex < rediscovery.length &&
      (rediscoverySelected + 1) / nextPosition <= ceiling + Number.EPSILON;

    if (mayTakeRediscovery) {
      out.push(rediscovery[rediscoveryIndex++]!);
      rediscoverySelected += 1;
      continue;
    }

    if (nonRediscoveryIndex < nonRediscovery.length) {
      out.push(nonRediscovery[nonRediscoveryIndex++]!);
      continue;
    }

    // CEILING_NOT_QUOTA: never create a quality failure just because all other
    // categories are exhausted. The relaxation is explicit in evidence.
    out.push(rediscovery[rediscoveryIndex++]!);
    rediscoverySelected += 1;
    ceilingRelaxedCount += 1;
  }

  return { entries: out, ceilingRelaxedCount };
}

function dedupeRecordingIdentity(
  input: { entries: ClassifiedEntry[]; ceilingRelaxedCount: number },
  identityByTrackId: Map<string, DiscoveryTrackIdentityEvidence>,
): { entries: ClassifiedEntry[]; droppedCount: number } & Pick<
  typeof input,
  "ceilingRelaxedCount"
> {
  const kept: ClassifiedEntry[] = [];
  let droppedCount = 0;

  for (const entry of input.entries) {
    const current =
      entry.matchable ?? toMatchableTrack(entry.candidate, identityByTrackId);
    if (!current) {
      kept.push(entry);
      continue;
    }

    const duplicate = kept.some((prior) => {
      const priorTrack =
        prior.matchable ?? toMatchableTrack(prior.candidate, identityByTrackId);
      if (!priorTrack) return prior.candidate.uri === entry.candidate.uri;
      if (priorTrack.spotifyTrackId === current.spotifyTrackId) return true;
      return Boolean(recordingIdentityMatchSource(priorTrack, current));
    });

    if (duplicate) {
      droppedCount += 1;
      continue;
    }
    kept.push(entry);
  }

  return {
    entries: kept,
    droppedCount,
    ceilingRelaxedCount: input.ceilingRelaxedCount,
  };
}

function normalizeCeiling(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("DISCOVERY rediscoveryCeiling must be between 0 and 1");
  }
  return value;
}
