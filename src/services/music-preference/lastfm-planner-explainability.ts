export const MUSIC_06_EXPLAINABILITY_EVIDENCE_KIND = "INFERRED" as const;
export const MUSIC_06_EXPLAINABILITY_EVIDENCE_METHOD =
  "LASTFM_PLANNED_SEQUENCE_GAP" as const;
export const MUSIC_06_EXPLAINABILITY_SOURCE_LABEL =
  "Last.fm + ordem publicada pelo Sonoriza" as const;

export type Music06ExplainabilityOutcome =
  | "DISABLED"
  | "ABSTAINED"
  | "NO_RERANK"
  | "RERANK_APPLIED"
  | "FAILED_SAFE";

export type Music06RunExplainability = Readonly<{
  policyVersion: string | null;
  status: string | null;
  policyEnabled: boolean;
  policyReason: string | null;
  approvalScope: string | null;
  boundedRerankAllowed: boolean;
  eligibilityChangeAllowed: boolean;
  sourceRunCount: number;
  selectedTargetCount: number;
  scrobbleCount: number | null;
  assessedOccurrenceCount: number;
  negativeOccurrenceCount: number;
  duplicateOccurrenceCount: number;
  conflictingOccurrenceCount: number;
  unprojectableOccurrenceCount: number;
  applicationCount: number;
  groupEvaluationCount: number;
  candidateOccurrenceCount: number;
  influencedCandidateOccurrenceCount: number;
  trackProjectionInfluenceCount: number;
  artistProjectionInfluenceCount: number;
  explicitPreferenceSuppressedCount: number;
  maxObservedMusicRankShift: number;
  applied: boolean;
  eligibilityChanged: boolean;
  applicationFailureCount: number;
  lastFailure: string | null;
  preparationFailure: string | null;
  evidenceKind: typeof MUSIC_06_EXPLAINABILITY_EVIDENCE_KIND;
  evidenceMethod: typeof MUSIC_06_EXPLAINABILITY_EVIDENCE_METHOD;
  sourceLabel: typeof MUSIC_06_EXPLAINABILITY_SOURCE_LABEL;
  outcome: Music06ExplainabilityOutcome;
}>;

export function parseMusic06RunExplainability(
  summary: unknown,
): Music06RunExplainability | null {
  const root = asRecord(summary);
  const raw = asRecord(root?.music06PlannerInfluence);
  if (!raw) return null;

  const policy = asRecord(raw.policy);
  const projection = asRecord(raw.projection);
  const application = asRecord(raw.application);
  const observation = asRecord(raw.observation);

  const policyEnabled = policy?.enabled === true;
  const status = stringOrNull(raw.status);
  const applied = application?.applied === true;
  const applicationFailureCount = count(application?.applicationFailureCount);
  const lastFailure = stringOrNull(application?.lastFailure);
  const preparationFailure = stringOrNull(raw.failure);

  const outcome: Music06ExplainabilityOutcome =
    applicationFailureCount > 0 || lastFailure
      ? "FAILED_SAFE"
      : !policyEnabled
        ? "DISABLED"
        : status !== "READY"
          ? "ABSTAINED"
          : applied
            ? "RERANK_APPLIED"
            : "NO_RERANK";

  return {
    policyVersion: stringOrNull(raw.policyVersion),
    status,
    policyEnabled,
    policyReason: stringOrNull(policy?.reason),
    approvalScope: stringOrNull(policy?.approvalScope),
    boundedRerankAllowed: policy?.boundedRerankAllowed === true,
    eligibilityChangeAllowed: policy?.eligibilityChangeAllowed === true,
    sourceRunCount: count(raw.sourceRunCount),
    selectedTargetCount: count(raw.selectedTargetCount),
    scrobbleCount: observation ? count(observation.scrobbleCount) : null,
    assessedOccurrenceCount: count(projection?.assessedOccurrenceCount),
    negativeOccurrenceCount: count(projection?.negativeOccurrenceCount),
    duplicateOccurrenceCount: count(projection?.duplicateOccurrenceCount),
    conflictingOccurrenceCount: count(projection?.conflictingOccurrenceCount),
    unprojectableOccurrenceCount: count(projection?.unprojectableOccurrenceCount),
    applicationCount: count(application?.applicationCount),
    groupEvaluationCount: count(application?.groupEvaluationCount),
    candidateOccurrenceCount: count(application?.candidateOccurrenceCount),
    influencedCandidateOccurrenceCount: count(
      application?.influencedCandidateOccurrenceCount,
    ),
    trackProjectionInfluenceCount: count(
      application?.trackProjectionInfluenceCount,
    ),
    artistProjectionInfluenceCount: count(
      application?.artistProjectionInfluenceCount,
    ),
    explicitPreferenceSuppressedCount: count(
      application?.explicitPreferenceSuppressedCount,
    ),
    maxObservedMusicRankShift: count(application?.maxObservedMusicRankShift),
    applied,
    eligibilityChanged: application?.eligibilityChanged === true,
    applicationFailureCount,
    lastFailure,
    preparationFailure,
    evidenceKind: MUSIC_06_EXPLAINABILITY_EVIDENCE_KIND,
    evidenceMethod: MUSIC_06_EXPLAINABILITY_EVIDENCE_METHOD,
    sourceLabel: MUSIC_06_EXPLAINABILITY_SOURCE_LABEL,
    outcome,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}
