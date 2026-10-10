/**
 * PODCAST-08 Gate 7A: read-only pilot readiness proof.
 *
 * Intentionally not connected to the Spotify writer. Returning READY_FOR_REVIEW
 * NEVER grants permission to publish: the Gate 5 production switch remains
 * hardcoded false pending explicit later authorization and a separate PR.
 */
export type Podcast08PilotProofStatus =
  | "READY_FOR_REVIEW"
  | "ABSTAIN_DISABLED"
  | "ABSTAIN_SCOPE"
  | "ABSTAIN_NO_APPROVED_SIMULATION"
  | "ABSTAIN_STALE_SIMULATION"
  | "ABSTAIN_CONFIG_CHANGED"
  | "ABSTAIN_PLAN_CHANGED"
  | "ABSTAIN_SPOTIFY_SNAPSHOT_CHANGED"
  | "ABSTAIN_BACKUP_MISSING"
  | "ABSTAIN_UNSAFE_TARGET"
  | "ABSTAIN_UNVERIFIED_OPERATIONAL_GATES";

export type Podcast08PilotPrewriteInput = Readonly<{
  requestedMode: string | null | undefined;
  explicitTargetId: string | null | undefined;
  targetIdsInRun: readonly string[];
  nowMs: number;
  approvedSimulation: Readonly<{
    runId: string;
    completedAtMs: number;
    status: "SUCCESS" | "FAILED" | "RUNNING";
    qualityPassed: boolean;
    usedDurationBands: boolean;
    configurationFingerprint: string;
    finalOrderHash: string;
  }> | null;
  currentConfigurationFingerprint: string;
  currentFinalOrderHash: string;
  /** Canonical snapshot recorded immediately before the proposed write. */
  snapshotAtPlanning: string | null;
  snapshotAtPrewrite: string | null;
  rollbackBackup: Readonly<{
    playlistId: string;
    snapshotId: string;
    orderedUrisCount: number;
    orderedUrisHash: string;
    backupArtifactRef: string;
    capturedAtMs: number;
  }> | null;
  destinationPlaylistId: string;
  singleBlock: boolean;
  containsStrictOrStatefulPodcast: boolean;
  sourcesAndCadenceRevalidated: boolean;
  reservationsRevalidated: boolean;
  spotifyPlaybackRevalidated: boolean;
  prewriteFenceConfirmed: boolean;
}>;

export type Podcast08PilotPrewriteEvidence = Readonly<{
  gate: "PODCAST-08-7A";
  status: Podcast08PilotProofStatus;
  canWriteSpotify: false;
  intendedTargetId: string | null;
  simulationRunId: string | null;
}>;

const MAX_SIMULATION_AGE_MS = 30 * 60_000;
const MAX_BACKUP_AGE_MS = 10 * 60_000;

/**
 * One-target pilot checklist evaluated from an authorized, fully revalidated
 * execution snapshot. No DB or provider I/O. Never auto-activates a pilot.
 */
export function evaluatePodcast08PilotPrewriteProof(
  input: Podcast08PilotPrewriteInput,
): Podcast08PilotPrewriteEvidence {
  const evidence = (status: Podcast08PilotProofStatus): Podcast08PilotPrewriteEvidence => ({
    gate: "PODCAST-08-7A",
    status,
    canWriteSpotify: false,
    intendedTargetId: input.explicitTargetId ?? null,
    simulationRunId: input.approvedSimulation?.runId ?? null,
  });

  if (input.requestedMode !== "PILOT_REVIEW") return evidence("ABSTAIN_DISABLED");
  if (
    !input.explicitTargetId ||
    input.targetIdsInRun.length !== 1 ||
    input.targetIdsInRun[0] !== input.explicitTargetId
  ) return evidence("ABSTAIN_SCOPE");

  if (!input.singleBlock || input.containsStrictOrStatefulPodcast) {
    return evidence("ABSTAIN_UNSAFE_TARGET");
  }

  const approved = input.approvedSimulation;
  if (
    !approved ||
    !approved.runId ||
    approved.status !== "SUCCESS" ||
    !approved.qualityPassed ||
    !approved.usedDurationBands ||
    !approved.configurationFingerprint ||
    !approved.finalOrderHash
  ) return evidence("ABSTAIN_NO_APPROVED_SIMULATION");

  if (
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(approved.completedAtMs) ||
    approved.completedAtMs > input.nowMs ||
    input.nowMs - approved.completedAtMs > MAX_SIMULATION_AGE_MS
  ) return evidence("ABSTAIN_STALE_SIMULATION");

  if (
    !input.currentConfigurationFingerprint ||
    approved.configurationFingerprint !== input.currentConfigurationFingerprint
  ) return evidence("ABSTAIN_CONFIG_CHANGED");

  if (
    !input.currentFinalOrderHash ||
    approved.finalOrderHash !== input.currentFinalOrderHash
  ) return evidence("ABSTAIN_PLAN_CHANGED");

  if (
    !input.snapshotAtPlanning ||
    !input.snapshotAtPrewrite ||
    input.snapshotAtPlanning !== input.snapshotAtPrewrite
  ) return evidence("ABSTAIN_SPOTIFY_SNAPSHOT_CHANGED");

  const backup = input.rollbackBackup;
  if (
    !backup ||
    !input.destinationPlaylistId ||
    backup.playlistId !== input.destinationPlaylistId ||
    backup.snapshotId !== input.snapshotAtPrewrite ||
    !Number.isSafeInteger(backup.orderedUrisCount) ||
    backup.orderedUrisCount < 0 ||
    !backup.orderedUrisHash.trim() ||
    !backup.backupArtifactRef.trim() ||
    !Number.isFinite(backup.capturedAtMs) ||
    backup.capturedAtMs > input.nowMs ||
    input.nowMs - backup.capturedAtMs > MAX_BACKUP_AGE_MS
  ) return evidence("ABSTAIN_BACKUP_MISSING");

  if (
    !input.sourcesAndCadenceRevalidated ||
    !input.reservationsRevalidated ||
    !input.spotifyPlaybackRevalidated ||
    !input.prewriteFenceConfirmed
  ) return evidence("ABSTAIN_UNVERIFIED_OPERATIONAL_GATES");

  // Even with every proof present, a separate reviewed write gate is required.
  return evidence("READY_FOR_REVIEW");
}


/**
 * Gate 7A guard for any real run that includes an explicitly allowlisted
 * PODCAST-08 ACTIVE destination. Until a later reviewed deployment enables a
 * full revalidated pilot, DO NOT silently write the legacy selection instead.
 * No DB, Spotify, or environment access.
 */
export function mustBlockPodcast08RequestedRealWrite(input: {
  simulate: boolean;
  mode: string | null | undefined;
  targetAllowlist: string | null | undefined;
  runTargetIds: readonly string[];
}): boolean {
  if (input.simulate || input.mode !== "ACTIVE") return false;
  const requestedIds = new Set(
    (input.targetAllowlist ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return input.runTargetIds.some((id) => requestedIds.has(id));
}
