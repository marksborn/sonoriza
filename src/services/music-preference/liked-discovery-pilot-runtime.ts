import type { Candidate } from "@/services/playlist-planner";
import type { Gate5FResolvedDiscoveryCandidate } from "@/services/music-discovery/planner-discovery-gate5f";

import {
  getLikedDiscoveryCalibrationShadowReport,
  type LikedDiscoveryCalibrationShadowReport,
} from "./liked-discovery-calibration-shadow";

export const LIKED_DISCOVERY_PILOT_RUNTIME_POLICY = {
  version: "liked-gate6c-pilot-v1",
  mode: "CONTROLLED_RUNTIME",
  maxCandidatesPerRun: 1,
  activationRule:
    "BASE_DISCOVERY_AND_MASTER_FLAG_AND_USER_ALLOWLIST_AND_TARGET_ID_ALLOWLIST",
  targetRule: "TARGET_DISCOVERY_POLICY_MUST_ALLOW_EXTERNAL_DISCOVERY",
  fallbackRule: "ABSTAIN_AND_KEEP_EXISTING_PLAN",
  plannerRule: "REUSE_DISCOVERY_GATE5H_SURGICAL_PATH",
  persistenceRule: "GENERATION_SUMMARY_ONLY",
} as const;

export type LikedDiscoveryPilotPolicyReason =
  | "BASE_DISCOVERY_DISABLED"
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "TARGET_ALLOWLIST_EMPTY"
  | "ENABLED";

export type LikedDiscoveryPilotResolutionStatus =
  | "DISABLED"
  | "ABSTAINED"
  | "READY";

export type LikedDiscoveryPilotEvidence = {
  policyVersion: typeof LIKED_DISCOVERY_PILOT_RUNTIME_POLICY.version;
  status: LikedDiscoveryPilotResolutionStatus;
  reason: string;
  enabled: boolean;
  userAllowlisted: boolean;
  targetAllowlistSize: number;
  calibrationReadiness: string | null;
  calibrationReasons: string[];
  sourceGeneratedAt: string | null;
  ambiguityRate: number | null;
  spotifyCatalogCalls: number;
  spotifyFailures: number;
  spotifyRateLimits: number;
  spotifyRetries: number;
  nearDuplicateQuarantined: number;
  selectedCandidate: {
    candidateKey: string;
    spotifyTrackId: string;
    artistName: string;
    trackName: string;
    rawScore: number;
    calibratedScore: number;
  } | null;
  duplicateSuppressedAgainstStandardDiscovery: boolean;
  failure: string | null;
};

export type LikedDiscoveryPilotResolution = {
  discovery: Gate5FResolvedDiscoveryCandidate | null;
  targetIds: ReadonlySet<string>;
  evidence: LikedDiscoveryPilotEvidence;
};

export function resolveLikedDiscoveryPilotPolicy(input: {
  baseDiscoveryEnabled: boolean;
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  allowlistedTargetIds?: string | null;
}): {
  enabled: boolean;
  reason: LikedDiscoveryPilotPolicyReason;
  targetIds: ReadonlySet<string>;
} {
  const targetIds = parseTargetIds(input.allowlistedTargetIds);
  if (!input.baseDiscoveryEnabled) {
    return { enabled: false, reason: "BASE_DISCOVERY_DISABLED", targetIds };
  }
  if (!parseBoolean(input.masterEnabled)) {
    return { enabled: false, reason: "MASTER_DISABLED", targetIds };
  }
  const email = normalizeEmail(input.userEmail);
  if (!email) {
    return { enabled: false, reason: "USER_EMAIL_MISSING", targetIds };
  }
  const users = new Set(
    String(input.allowlistedEmails ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value): value is string => Boolean(value)),
  );
  if (!users.has(email)) {
    return { enabled: false, reason: "USER_NOT_ALLOWLISTED", targetIds };
  }
  if (targetIds.size === 0) {
    return { enabled: false, reason: "TARGET_ALLOWLIST_EMPTY", targetIds };
  }
  return { enabled: true, reason: "ENABLED", targetIds };
}

export async function resolveLikedDiscoveryPilotRuntime(input: {
  userId: string;
  userEmail: string | null | undefined;
  baseDiscoveryEnabled: boolean;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  allowlistedTargetIds?: string | null;
}): Promise<LikedDiscoveryPilotResolution> {
  const policy = resolveLikedDiscoveryPilotPolicy(input);
  const baseEvidence = evidenceBase(policy);
  if (!policy.enabled) {
    return {
      discovery: null,
      targetIds: policy.targetIds,
      evidence: {
        ...baseEvidence,
        status: "DISABLED",
        reason: policy.reason,
      },
    };
  }

  let calibration: LikedDiscoveryCalibrationShadowReport;
  try {
    calibration = await getLikedDiscoveryCalibrationShadowReport(input.userId);
  } catch (error) {
    return {
      discovery: null,
      targetIds: policy.targetIds,
      evidence: {
        ...baseEvidence,
        status: "ABSTAINED",
        reason: "CALIBRATION_FAILED",
        failure: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const hydrated = evidenceFromCalibration(baseEvidence, calibration);
  if (calibration.readiness.status !== "READY_FOR_CONTROLLED_PILOT") {
    return {
      discovery: null,
      targetIds: policy.targetIds,
      evidence: {
        ...hydrated,
        status: "ABSTAINED",
        reason: "CALIBRATION_NOT_READY",
      },
    };
  }

  const pilot = calibration.pilotCandidates[0] ?? null;
  if (!pilot) {
    return {
      discovery: null,
      targetIds: policy.targetIds,
      evidence: {
        ...hydrated,
        status: "ABSTAINED",
        reason: "NO_CALIBRATED_EXPLORATORY_CANDIDATE",
      },
    };
  }

  const discovery = toGate5FDiscoveryCandidate(pilot);
  return {
    discovery,
    targetIds: policy.targetIds,
    evidence: {
      ...hydrated,
      status: "READY",
      reason: "READY_FOR_TARGET_SCOPED_PILOT",
      selectedCandidate: {
        candidateKey: discovery.candidateKey,
        spotifyTrackId: discovery.candidate.spotifyTrackId!,
        artistName: discovery.candidate.primaryArtistName ?? discovery.candidate.subtitle ?? "",
        trackName: discovery.candidate.title,
        rawScore: discovery.rawScore,
        calibratedScore: discovery.adjustedScore,
      },
    },
  };
}

export function toGate5FDiscoveryCandidate(
  pilot: LikedDiscoveryCalibrationShadowReport["pilotCandidates"][number],
): Gate5FResolvedDiscoveryCandidate {
  const candidate: Candidate = {
    uri: pilot.spotifyUri,
    type: "MUSIC",
    title: pilot.trackName,
    subtitle: pilot.artistName,
    spotifyTrackId: pilot.spotifyTrackId,
    primaryArtistId: pilot.spotifyArtistId,
    primaryArtistName: pilot.artistName,
    ...(pilot.albumId ? { albumId: pilot.albumId } : {}),
    ...(pilot.albumName ? { albumName: pilot.albumName } : {}),
    durationMs: pilot.durationMs,
  };
  return {
    candidateKey: `liked:${pilot.candidateKey}`,
    candidate,
    rawScore: pilot.scoreCard.score,
    adjustedScore: pilot.calibratedScore,
    historyClass: "LIKED_SIMILAR_EXPLORATORY_NEW",
    pathLabel: "LIKED_SIMILAR_EXPLORATORY",
    resolutionReason: pilot.resolutionReason,
    isrc: pilot.isrc,
  };
}

export function isLikedDiscoveryPilotCandidate(
  discovery: Gate5FResolvedDiscoveryCandidate,
): boolean {
  return discovery.pathLabel === "LIKED_SIMILAR_EXPLORATORY";
}

export function discoveriesForPilotTarget(
  discoveries: Gate5FResolvedDiscoveryCandidate[],
  targetPlaylistId: string,
  allowedTargetIds: ReadonlySet<string>,
): Gate5FResolvedDiscoveryCandidate[] {
  return discoveries.filter(
    (discovery) =>
      !isLikedDiscoveryPilotCandidate(discovery) ||
      allowedTargetIds.has(targetPlaylistId),
  );
}

export function mergeLikedPilotWithStandardDiscovery(input: {
  standard: Gate5FResolvedDiscoveryCandidate[];
  pilot: Gate5FResolvedDiscoveryCandidate | null;
}): {
  discoveries: Gate5FResolvedDiscoveryCandidate[];
  duplicateSuppressed: boolean;
} {
  if (!input.pilot) return { discoveries: [...input.standard], duplicateSuppressed: false };
  const pilotId = candidateIdentity(input.pilot.candidate);
  const duplicate = input.standard.some(
    (row) => candidateIdentity(row.candidate) === pilotId,
  );
  if (duplicate) {
    return { discoveries: [...input.standard], duplicateSuppressed: true };
  }
  return {
    discoveries: [...input.standard, input.pilot],
    duplicateSuppressed: false,
  };
}

function evidenceBase(policy: ReturnType<typeof resolveLikedDiscoveryPilotPolicy>): LikedDiscoveryPilotEvidence {
  return {
    policyVersion: LIKED_DISCOVERY_PILOT_RUNTIME_POLICY.version,
    status: "DISABLED",
    reason: policy.reason,
    enabled: policy.enabled,
    userAllowlisted: policy.reason === "ENABLED" || policy.reason === "TARGET_ALLOWLIST_EMPTY",
    targetAllowlistSize: policy.targetIds.size,
    calibrationReadiness: null,
    calibrationReasons: [],
    sourceGeneratedAt: null,
    ambiguityRate: null,
    spotifyCatalogCalls: 0,
    spotifyFailures: 0,
    spotifyRateLimits: 0,
    spotifyRetries: 0,
    nearDuplicateQuarantined: 0,
    selectedCandidate: null,
    duplicateSuppressedAgainstStandardDiscovery: false,
    failure: null,
  };
}

function evidenceFromCalibration(
  base: LikedDiscoveryPilotEvidence,
  calibration: LikedDiscoveryCalibrationShadowReport,
): LikedDiscoveryPilotEvidence {
  return {
    ...base,
    calibrationReadiness: calibration.readiness.status,
    calibrationReasons: [...calibration.readiness.reasons],
    sourceGeneratedAt: calibration.sourceExpansion.generatedAt.toISOString(),
    ambiguityRate: calibration.sourceExpansion.ambiguityRate,
    spotifyCatalogCalls: calibration.sourceExpansion.spotifyCatalogCalls,
    spotifyFailures: calibration.sourceExpansion.spotifyFailures,
    spotifyRateLimits: calibration.sourceExpansion.spotifyRateLimits,
    spotifyRetries: calibration.sourceExpansion.spotifyRetries,
    nearDuplicateQuarantined: calibration.nearDuplicates.quarantined,
  };
}

function candidateIdentity(candidate: Candidate): string {
  const trackId = candidate.spotifyTrackId?.trim();
  return trackId ? `track:${trackId}` : `uri:${candidate.uri}`;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function parseTargetIds(value: string | null | undefined): ReadonlySet<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function parseBoolean(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}
