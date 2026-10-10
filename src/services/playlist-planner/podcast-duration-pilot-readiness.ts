/**
 * PODCAST-08 Gate 7: evidence review only. This module never authorizes a
 * Spotify write and cannot be used as a write grant.
 *
 * The actual productive selector remains hard-disabled in Gate 5A. An
 * explicit future implementation/review will be required to change that.
 */
export type Podcast08PilotReadinessReason =
  | "NO_SINGLE_TARGET"
  | "TARGET_NOT_ALLOWLISTED"
  | "MISSING_CURRENT_FINGERPRINT"
  | "SIMULATION_NOT_SUCCESS"
  | "SIMULATION_NOT_ISOLATED"
  | "SIMULATION_NOT_EXPERIMENTAL"
  | "SIMULATION_NOT_ACTIVE"
  | "SIMULATION_COLLECTION_INCOMPLETE"
  | "SIMULATION_HAS_QUALITY_FAILURES"
  | "SIMULATION_FINGERPRINT_MISMATCH"
  | "SNAPSHOT_UNAVAILABLE"
  | "SNAPSHOT_CHANGED"
  | "ROLLBACK_NOT_READY"
  | "CI_NOT_GREEN"
  | "REVIEW_NOT_APPROVED";

export type Podcast08PilotReadiness = Readonly<{
  gate: 7;
  status: "REVIEW_CANDIDATE" | "BLOCKED";
  reasons: readonly Podcast08PilotReadinessReason[];
  targetId: string;
  productiveWritesAllowed: false;
  requiresSeparateImplementation: true;
}>;

type SimulationSummary = Readonly<{
  configurationFingerprint?: unknown;
  targetScope?: unknown;
  podcast08SimulationOnly?: unknown;
  podcast08ActiveGate?: unknown;
  collectionComplete?: unknown;
  inconclusive?: unknown;
  qualityFailures?: unknown;
}>;

/**
 * Provide only evidence actually captured at review time. Never infer
 * snapshots, a passing CI check, or operational approval from a flag.
 *
 * NOTE: experimental runs intentionally fail CONFIG-04 qualityPassed, and
 * are NOT productive-run approval. Instead we independently verify their
 * collection and qualityFailures, then require human review.
 */
export function assessPodcast08PilotReadiness(input: {
  targetId: string;
  allowlistedTargetIds: readonly string[];
  currentConfigurationFingerprint: string | null;
  simulation: {
    status: "SUCCESS" | "PARTIAL" | "FAILED" | "RUNNING";
    summary: SimulationSummary;
  } | null;
  simulationSpotifySnapshotId: string | null;
  currentSpotifySnapshotId: string | null;
  rollback: {
    capturedOrderHash: string | null;
    capturedSnapshotId: string | null;
    restoreProcedureReviewed: boolean;
  };
  ciGreen: boolean;
  operationalReviewApproved: boolean;
}): Podcast08PilotReadiness {
  const reasons: Podcast08PilotReadinessReason[] = [];
  const reject = (reason: Podcast08PilotReadinessReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (!input.targetId.trim() || input.allowlistedTargetIds.length !== 1) {
    reject("NO_SINGLE_TARGET");
  }
  if (
    input.allowlistedTargetIds.length !== 1 ||
    input.allowlistedTargetIds[0] !== input.targetId
  ) {
    reject("TARGET_NOT_ALLOWLISTED");
  }
  if (!input.currentConfigurationFingerprint?.trim()) {
    reject("MISSING_CURRENT_FINGERPRINT");
  }
  const simulation = input.simulation;
  if (!simulation || simulation.status !== "SUCCESS") {
    reject("SIMULATION_NOT_SUCCESS");
  }
  const summary = simulation?.summary;
  if (
    !Array.isArray(summary?.targetScope) ||
    summary.targetScope.length !== 1 ||
    summary.targetScope[0] !== input.targetId
  ) {
    reject("SIMULATION_NOT_ISOLATED");
  }
  if (summary?.podcast08SimulationOnly !== true) {
    reject("SIMULATION_NOT_EXPERIMENTAL");
  }
  const gate = summary?.podcast08ActiveGate;
  const gateRow = gate && typeof gate === "object" && !Array.isArray(gate)
    ? gate as Record<string, unknown>
    : null;
  const decisions = Array.isArray(gateRow?.targets) ? gateRow.targets : [];
  const onlyDecision = decisions.length === 1 && decisions[0] &&
    typeof decisions[0] === "object" ? decisions[0] as Record<string, unknown> : null;
  const runtime = onlyDecision?.runtime;
  const runtimeEntry = runtime && typeof runtime === "object" && !Array.isArray(runtime)
    ? runtime as Record<string, unknown> : null;
  if (
    gateRow?.simulate !== true ||
    gateRow?.spotifyWritesEnabled !== false ||
    gateRow?.realRunApprovalEligible !== false ||
    onlyDecision?.targetPlaylistId !== input.targetId ||
    onlyDecision?.status !== "ACTIVE_ALLOWED" ||
    runtimeEntry?.status !== "ACTIVE"
  ) {
    reject("SIMULATION_NOT_ACTIVE");
  }
  if (summary?.collectionComplete !== true || summary?.inconclusive !== false) {
    reject("SIMULATION_COLLECTION_INCOMPLETE");
  }
  if (!Array.isArray(summary?.qualityFailures) ||
      summary.qualityFailures.length !== 0) {
    reject("SIMULATION_HAS_QUALITY_FAILURES");
  }
  if (
    typeof summary?.configurationFingerprint !== "string" ||
    summary.configurationFingerprint !== input.currentConfigurationFingerprint
  ) {
    reject("SIMULATION_FINGERPRINT_MISMATCH");
  }
  if (!input.currentSpotifySnapshotId?.trim() ||
      !input.simulationSpotifySnapshotId?.trim()) {
    reject("SNAPSHOT_UNAVAILABLE");
  } else if (
    input.currentSpotifySnapshotId !== input.simulationSpotifySnapshotId
  ) {
    reject("SNAPSHOT_CHANGED");
  }
  if (
    !input.rollback.restoreProcedureReviewed ||
    !input.rollback.capturedOrderHash?.trim() ||
    !input.rollback.capturedSnapshotId?.trim() ||
    input.rollback.capturedSnapshotId !== input.currentSpotifySnapshotId
  ) {
    reject("ROLLBACK_NOT_READY");
  }
  if (!input.ciGreen) reject("CI_NOT_GREEN");
  if (!input.operationalReviewApproved) reject("REVIEW_NOT_APPROVED");
  return {
    gate: 7,
    status: reasons.length === 0 ? "REVIEW_CANDIDATE" : "BLOCKED",
    reasons,
    targetId: input.targetId,
    productiveWritesAllowed: false,
    requiresSeparateImplementation: true,
  };
}

/**
 * A real run with an explicit PODCAST-08 pilot target requested is an error,
 * not an opportunity to silently publish the older selection algorithm.
 *
 * Default mode OFF, empty allowlist, or a non-targeted run remain unchanged.
 */
export function podcast08UnapprovedRealPilotTargetIds(input: {
  simulate: boolean;
  activeMode: string | null | undefined;
  allowlistCsv: string | null | undefined;
  runTargetIds: readonly string[];
  /** Any persisted non-ANY SEQUENCE destination may not silently use legacy writes. */
  configuredSpecificBandTargetIds?: readonly string[];
}): string[] {
  if (input.simulate) return [];
  const allowlist = input.activeMode === "ACTIVE"
    ? new Set(
        (input.allowlistCsv ?? "").split(",").map(s => s.trim()).filter(Boolean),
      )
    : new Set<string>();
  const configuredBands = new Set(input.configuredSpecificBandTargetIds ?? []);
  return input.runTargetIds.filter(id => allowlist.has(id) || configuredBands.has(id));
}
