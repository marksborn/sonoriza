import { createHash } from "node:crypto";

import type {
  ReconciledSpotifyExtendedEvent,
  SpotifyExtendedReconciliation,
} from "./reconcile";

export type SpotifyExtendedPersistenceActionKind =
  | "INSERT_NEW"
  | "ENRICH_EXISTING"
  | "QUARANTINE_CONFLICT"
  | "NOOP_ALREADY_ENRICHED";

export type SpotifyExtendedPersistenceAction = {
  kind: SpotifyExtendedPersistenceActionKind;
  sourceEventKey: string;
  existingEventId: string | null;
  classification: ReconciledSpotifyExtendedEvent["classification"];
  conflictReason: ReconciledSpotifyExtendedEvent["conflictReason"];
  candidateCount: number;
};

export type SpotifyExtendedPersistencePlanSummary = {
  insertNew: number;
  enrichExisting: number;
  quarantineConflict: number;
  noopAlreadyEnriched: number;
};

export type SpotifyExtendedPersistencePlan = {
  version: 1;
  packageSha256: string;
  planHash: string;
  actions: SpotifyExtendedPersistenceAction[];
  summary: SpotifyExtendedPersistencePlanSummary;
};

export function buildSpotifyExtendedPersistencePlan(
  packageSha256: string,
  reconciliation: SpotifyExtendedReconciliation,
): SpotifyExtendedPersistencePlan {
  const actions = reconciliation.entries.map(toPersistenceAction);
  return persistencePlanFromActions(packageSha256, actions);
}

export function persistencePlanFromActions(
  packageSha256: string,
  actions: SpotifyExtendedPersistenceAction[],
): SpotifyExtendedPersistencePlan {
  return {
    version: 1,
    packageSha256,
    planHash: calculateSpotifyExtendedPersistencePlanHash(packageSha256, actions),
    actions,
    summary: summarizeSpotifyExtendedPersistenceActions(actions),
  };
}

export function calculateSpotifyExtendedPersistencePlanHash(
  packageSha256: string,
  actions: SpotifyExtendedPersistenceAction[],
): string {
  const canonical = {
    version: 1,
    packageSha256,
    actions: actions.map((action) => ({
      kind: action.kind,
      sourceEventKey: action.sourceEventKey,
      existingEventId: action.existingEventId,
      classification: action.classification,
      conflictReason: action.conflictReason,
      candidateCount: action.candidateCount,
    })),
  };

  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export function summarizeSpotifyExtendedPersistenceActions(
  actions: SpotifyExtendedPersistenceAction[],
): SpotifyExtendedPersistencePlanSummary {
  const summary: SpotifyExtendedPersistencePlanSummary = {
    insertNew: 0,
    enrichExisting: 0,
    quarantineConflict: 0,
    noopAlreadyEnriched: 0,
  };

  for (const action of actions) {
    if (action.kind === "INSERT_NEW") summary.insertNew += 1;
    else if (action.kind === "ENRICH_EXISTING") summary.enrichExisting += 1;
    else if (action.kind === "QUARANTINE_CONFLICT") summary.quarantineConflict += 1;
    else summary.noopAlreadyEnriched += 1;
  }

  return summary;
}

function toPersistenceAction(
  entry: ReconciledSpotifyExtendedEvent,
): SpotifyExtendedPersistenceAction {
  if (entry.classification === "NEW_UNCOVERED_EVENT") {
    return baseAction(entry, "INSERT_NEW", null);
  }

  if (entry.classification === "CONFLICT_AMBIGUOUS") {
    return baseAction(entry, "QUARANTINE_CONFLICT", null);
  }

  if (!entry.matchedExistingEventId) {
    throw new Error(
      `HISTORY-02 invariant violated: exact match without existing event for ${entry.event.sourceEventKey}`,
    );
  }

  return baseAction(
    entry,
    entry.enrichmentCandidate ? "ENRICH_EXISTING" : "NOOP_ALREADY_ENRICHED",
    entry.matchedExistingEventId,
  );
}

function baseAction(
  entry: ReconciledSpotifyExtendedEvent,
  kind: SpotifyExtendedPersistenceActionKind,
  existingEventId: string | null,
): SpotifyExtendedPersistenceAction {
  return {
    kind,
    sourceEventKey: entry.event.sourceEventKey,
    existingEventId,
    classification: entry.classification,
    conflictReason: entry.conflictReason,
    candidateCount: entry.candidateCount,
  };
}
