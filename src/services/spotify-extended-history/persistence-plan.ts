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

export type SpotifyExtendedPersistenceConflictReason =
  | NonNullable<ReconciledSpotifyExtendedEvent["conflictReason"]>
  | "REUSED_EXISTING_TARGET"
  | null;

export type SpotifyExtendedPersistenceAction = {
  kind: SpotifyExtendedPersistenceActionKind;
  sourceEventKey: string;
  existingEventId: string | null;
  classification: ReconciledSpotifyExtendedEvent["classification"];
  conflictReason: SpotifyExtendedPersistenceConflictReason;
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
  const actions = quarantineReusedExistingTargets(
    reconciliation.entries.map(toPersistenceAction),
  );
  return persistencePlanFromActions(packageSha256, actions);
}

export function persistencePlanFromActions(
  packageSha256: string,
  actions: SpotifyExtendedPersistenceAction[],
): SpotifyExtendedPersistencePlan {
  assertUniqueEnrichmentTargets(actions);

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

function quarantineReusedExistingTargets(
  actions: SpotifyExtendedPersistenceAction[],
): SpotifyExtendedPersistenceAction[] {
  const enrichmentTargetCounts = new Map<string, number>();

  for (const action of actions) {
    if (action.kind !== "ENRICH_EXISTING" || !action.existingEventId) continue;
    enrichmentTargetCounts.set(
      action.existingEventId,
      (enrichmentTargetCounts.get(action.existingEventId) ?? 0) + 1,
    );
  }

  return actions.map((action) => {
    if (action.kind !== "ENRICH_EXISTING" || !action.existingEventId) return action;
    const reuseCount = enrichmentTargetCounts.get(action.existingEventId) ?? 0;
    if (reuseCount <= 1) return action;

    // Multiple export events competing for one canonical listening event are
    // globally ambiguous even when each one looked exact in isolation. Do not
    // choose a winner by timestamp proximity: quarantine the whole collision
    // group so persistence always preserves a demonstrable 1:1 relationship.
    return {
      ...action,
      kind: "QUARANTINE_CONFLICT",
      existingEventId: null,
      classification: "CONFLICT_AMBIGUOUS",
      conflictReason: "REUSED_EXISTING_TARGET",
      candidateCount: reuseCount,
    };
  });
}

function assertUniqueEnrichmentTargets(
  actions: SpotifyExtendedPersistenceAction[],
): void {
  const seen = new Set<string>();
  let reusedTargets = 0;

  for (const action of actions) {
    if (action.kind !== "ENRICH_EXISTING" || !action.existingEventId) continue;
    if (seen.has(action.existingEventId)) reusedTargets += 1;
    else seen.add(action.existingEventId);
  }

  if (reusedTargets > 0) {
    throw new Error(
      `HISTORY-02 persistence plan reuses existingEventId across ENRICH_EXISTING actions (${reusedTargets} extra reuse actions)`,
    );
  }
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
