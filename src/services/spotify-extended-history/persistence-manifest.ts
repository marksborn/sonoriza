import { createHash } from "node:crypto";

import {
  persistencePlanFromActions,
  type SpotifyExtendedPersistenceAction,
  type SpotifyExtendedPersistenceActionKind,
  type SpotifyExtendedPersistencePlan,
  type SpotifyExtendedPersistencePlanSummary,
} from "./persistence-plan";
import type {
  SpotifyExtendedClassification,
  SpotifyExtendedConflictReason,
} from "./reconcile";

export type SpotifyExtendedPersistenceManifest = {
  version: 1;
  userId: string;
  packageSha256: string;
  planVersion: 1;
  planHash: string;
  manifestHash: string;
  actions: SpotifyExtendedPersistenceAction[];
  summary: SpotifyExtendedPersistencePlanSummary;
};

const ACTION_KINDS = new Set<SpotifyExtendedPersistenceActionKind>([
  "INSERT_NEW",
  "ENRICH_EXISTING",
  "QUARANTINE_CONFLICT",
  "NOOP_ALREADY_ENRICHED",
]);

const CLASSIFICATIONS = new Set<SpotifyExtendedClassification>([
  "EXACT_EXISTING_LASTFM",
  "EXACT_EXISTING_RECENTLY_PLAYED",
  "EXACT_EXISTING_EXTENDED_HISTORY",
  "NEW_UNCOVERED_EVENT",
  "CONFLICT_AMBIGUOUS",
]);

const CONFLICT_REASONS = new Set<SpotifyExtendedConflictReason>([
  "MULTIPLE_CONFIDENT_LASTFM",
  "MULTIPLE_CONFIDENT_SPOTIFY",
  "CONFIDENT_CROSS_SOURCE",
  "NEAR_ONLY_LASTFM",
  "NEAR_ONLY_SPOTIFY",
  "NEAR_CROSS_SOURCE",
]);

export function buildSpotifyExtendedPersistenceManifest(
  userId: string,
  plan: SpotifyExtendedPersistencePlan,
): SpotifyExtendedPersistenceManifest {
  if (!userId.trim()) throw new Error("HISTORY-02 manifest requires userId");

  return {
    version: 1,
    userId,
    packageSha256: plan.packageSha256,
    planVersion: plan.version,
    planHash: plan.planHash,
    manifestHash: calculateSpotifyExtendedManifestHash(
      userId,
      plan.packageSha256,
      plan.version,
      plan.planHash,
    ),
    actions: plan.actions,
    summary: plan.summary,
  };
}

export function parseSpotifyExtendedPersistenceManifest(
  value: unknown,
): SpotifyExtendedPersistenceManifest {
  if (!isRecord(value)) throw new Error("HISTORY-02 manifest must be an object");
  if (value.version !== 1) throw new Error("HISTORY-02 manifest version is not supported");
  if (typeof value.userId !== "string" || !value.userId.trim()) {
    throw new Error("HISTORY-02 manifest userId is invalid");
  }
  if (!isSha256(value.packageSha256)) {
    throw new Error("HISTORY-02 manifest packageSha256 is invalid");
  }
  if (value.planVersion !== 1) throw new Error("HISTORY-02 manifest planVersion is not supported");
  if (!isSha256(value.planHash)) throw new Error("HISTORY-02 manifest planHash is invalid");
  if (!isSha256(value.manifestHash)) throw new Error("HISTORY-02 manifest manifestHash is invalid");
  if (!Array.isArray(value.actions)) throw new Error("HISTORY-02 manifest actions are invalid");

  const actions = value.actions.map((action, index) => parseAction(action, index));
  const sourceEventKeys = new Set(actions.map((action) => action.sourceEventKey));
  if (sourceEventKeys.size !== actions.length) {
    throw new Error("HISTORY-02 manifest contains duplicate sourceEventKey values");
  }

  const reconstructed = persistencePlanFromActions(value.packageSha256, actions);
  if (reconstructed.planHash !== value.planHash) {
    throw new Error("HISTORY-02 manifest plan hash does not match its actions");
  }

  if (!isRecord(value.summary)) throw new Error("HISTORY-02 manifest summary is invalid");
  const storedSummary = parseSummary(value.summary);
  if (JSON.stringify(storedSummary) !== JSON.stringify(reconstructed.summary)) {
    throw new Error("HISTORY-02 manifest summary does not match its actions");
  }

  const manifestHash = calculateSpotifyExtendedManifestHash(
    value.userId,
    value.packageSha256,
    value.planVersion,
    value.planHash,
  );
  if (manifestHash !== value.manifestHash) {
    throw new Error("HISTORY-02 manifest hash is invalid");
  }

  return {
    version: 1,
    userId: value.userId,
    packageSha256: value.packageSha256,
    planVersion: 1,
    planHash: value.planHash,
    manifestHash: value.manifestHash,
    actions,
    summary: reconstructed.summary,
  };
}

export function calculateSpotifyExtendedManifestHash(
  userId: string,
  packageSha256: string,
  planVersion: 1,
  planHash: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      userId,
      packageSha256,
      planVersion,
      planHash,
    }))
    .digest("hex");
}

function parseAction(value: unknown, index: number): SpotifyExtendedPersistenceAction {
  if (!isRecord(value)) throw new Error(`HISTORY-02 manifest action ${index} is invalid`);
  if (typeof value.kind !== "string" || !ACTION_KINDS.has(value.kind as SpotifyExtendedPersistenceActionKind)) {
    throw new Error(`HISTORY-02 manifest action ${index} kind is invalid`);
  }
  if (typeof value.sourceEventKey !== "string" || !value.sourceEventKey) {
    throw new Error(`HISTORY-02 manifest action ${index} sourceEventKey is invalid`);
  }
  if (value.existingEventId !== null && typeof value.existingEventId !== "string") {
    throw new Error(`HISTORY-02 manifest action ${index} existingEventId is invalid`);
  }
  if (
    typeof value.classification !== "string"
    || !CLASSIFICATIONS.has(value.classification as SpotifyExtendedClassification)
  ) {
    throw new Error(`HISTORY-02 manifest action ${index} classification is invalid`);
  }
  if (
    value.conflictReason !== null
    && (
      typeof value.conflictReason !== "string"
      || !CONFLICT_REASONS.has(value.conflictReason as SpotifyExtendedConflictReason)
    )
  ) {
    throw new Error(`HISTORY-02 manifest action ${index} conflictReason is invalid`);
  }
  if (!Number.isSafeInteger(value.candidateCount) || (value.candidateCount as number) < 0) {
    throw new Error(`HISTORY-02 manifest action ${index} candidateCount is invalid`);
  }

  return {
    kind: value.kind as SpotifyExtendedPersistenceActionKind,
    sourceEventKey: value.sourceEventKey,
    existingEventId: value.existingEventId as string | null,
    classification: value.classification as SpotifyExtendedClassification,
    conflictReason: value.conflictReason as SpotifyExtendedConflictReason | null,
    candidateCount: value.candidateCount as number,
  };
}

function parseSummary(value: Record<string, unknown>): SpotifyExtendedPersistencePlanSummary {
  return {
    insertNew: nonNegativeInteger(value.insertNew, "insertNew"),
    enrichExisting: nonNegativeInteger(value.enrichExisting, "enrichExisting"),
    quarantineConflict: nonNegativeInteger(value.quarantineConflict, "quarantineConflict"),
    noopAlreadyEnriched: nonNegativeInteger(value.noopAlreadyEnriched, "noopAlreadyEnriched"),
  };
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`HISTORY-02 manifest summary ${name} is invalid`);
  }
  return value as number;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
