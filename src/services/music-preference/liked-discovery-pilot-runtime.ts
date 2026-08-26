import type { Candidate } from "@/services/playlist-planner";
import type { Gate5FResolvedDiscoveryCandidate } from "@/services/music-discovery/planner-discovery-gate5f";
import {
  resolveExternalDiscoveryCandidate,
  type SpotifyDiscoveryResolution,
} from "@/services/music-discovery/spotify-resolution";
import { SpotifyCatalogSearchClient } from "@/services/spotify/catalog-search";

import {
  buildLikedDiscoveryCalibrationShadowReport,
  type LikedDiscoveryCalibrationShadowReport,
} from "./liked-discovery-calibration-shadow";
import {
  getLikedDiscoveryExpansionShadowReport,
  type LikedExpansionResolvedCandidate,
} from "./liked-discovery-expansion-shadow";

export const LIKED_DISCOVERY_PILOT_RUNTIME_POLICY = {
  version: "liked-gate6c-pilot-v1",
  mode: "CONTROLLED_RUNTIME",
  maxCandidatesPerRun: 1,
  activationRule:
    "BASE_DISCOVERY_AND_MASTER_FLAG_AND_USER_ALLOWLIST_AND_TARGET_ID_ALLOWLIST",
  targetRule: "TARGET_DISCOVERY_POLICY_MUST_ALLOW_EXTERNAL_DISCOVERY",
  fallbackRule: "ABSTAIN_AND_KEEP_EXISTING_PLAN",
  plannerRule: "REUSE_DISCOVERY_GATE5H_SURGICAL_PATH",
  identityRule: "REVALIDATE_EXACT_TRACK_AND_ARTIST_BEFORE_RUNTIME_HANDOFF",
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
  revalidationSpotifyCatalogCalls: number;
  revalidationSpotifyFailures: number;
  revalidationSpotifyRateLimits: number;
  revalidationSpotifyRetries: number;
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
    return disabled(policy.targetIds, baseEvidence, policy.reason);
  }

  let expansion;
  try {
    expansion = await getLikedDiscoveryExpansionShadowReport(input.userId);
  } catch (error) {
    return abstained(policy.targetIds, baseEvidence, "EXPANSION_FAILED", error);
  }

  const calibration = buildLikedDiscoveryCalibrationShadowReport(expansion);
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

  const selected = calibration.calibratedTop.find(
    (row) => row.source === "LIKED_EXPANSION" && Boolean(row.spotifyTrackId),
  );
  if (!selected?.spotifyTrackId) {
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
  const source = expansion.resolvedCandidates.find(
    (row) => row.spotifyTrackId === selected.spotifyTrackId,
  );
  if (!source) {
    return {
      discovery: null,
      targetIds: policy.targetIds,
      evidence: {
        ...hydrated,
        status: "ABSTAINED",
        reason: "CALIBRATED_CANDIDATE_SOURCE_MISSING",
      },
    };
  }

  const spotify = await SpotifyCatalogSearchClient.forUser(input.userId);
  let revalidated: SpotifyDiscoveryResolution;
  try {
    revalidated = await resolveExternalDiscoveryCandidate(spotify, {
      candidateKey: `liked-pilot:${source.candidateKey}`,
      candidateType: "TRACK",
      artistName: source.artistName,
      trackName: source.trackName,
      preferredSpotifyArtistId: source.spotifyArtistId,
    });
  } catch (error) {
    return abstained(
      policy.targetIds,
      evidenceWithRevalidationMetrics(hydrated, spotify.getMetrics()),
      "PILOT_TRACK_REVALIDATION_FAILED",
      error,
    );
  }
  const evidence = evidenceWithRevalidationMetrics(hydrated, spotify.getMetrics());
  if (
    revalidated.status !== "RESOLVED" ||
    !revalidated.spotifyArtist ||
    !revalidated.spotifyTrack
  ) {
    return {
      discovery: null,
      targetIds: policy.targetIds,
      evidence: {
        ...evidence,
        status: "ABSTAINED",
        reason: `PILOT_TRACK_REVALIDATION_${revalidated.status}`,
      },
    };
  }
  if (
    revalidated.spotifyArtist.id !== source.spotifyArtistId ||
    revalidated.spotifyTrack.id !== source.spotifyTrackId
  ) {
    return {
      discovery: null,
      targetIds: policy.targetIds,
      evidence: {
        ...evidence,
        status: "ABSTAINED",
        reason: "PILOT_TRACK_IDENTITY_CHANGED",
      },
    };
  }

  const discovery = toGate5FDiscoveryCandidate({
    source,
    calibratedScore: selected.calibratedScore,
    resolution: revalidated,
  });
  return {
    discovery,
    targetIds: policy.targetIds,
    evidence: {
      ...evidence,
      status: "READY",
      reason: "READY_FOR_TARGET_SCOPED_PILOT",
      selectedCandidate: {
        candidateKey: discovery.candidateKey,
        spotifyTrackId: discovery.candidate.spotifyTrackId!,
        artistName:
          discovery.candidate.primaryArtistName ?? discovery.candidate.subtitle ?? "",
        trackName: discovery.candidate.title,
        rawScore: discovery.rawScore,
        calibratedScore: discovery.adjustedScore,
      },
    },
  };
}

export function toGate5FDiscoveryCandidate(input: {
  source: LikedExpansionResolvedCandidate;
  calibratedScore: number;
  resolution: SpotifyDiscoveryResolution;
}): Gate5FResolvedDiscoveryCandidate {
  const { source, calibratedScore, resolution } = input;
  if (
    resolution.status !== "RESOLVED" ||
    !resolution.spotifyArtist ||
    !resolution.spotifyTrack
  ) {
    throw new Error("Gate 6C requires a revalidated resolved Spotify track");
  }
  const track = resolution.spotifyTrack;
  const artist = resolution.spotifyArtist;
  const candidate: Candidate = {
    uri: track.uri,
    type: "MUSIC",
    title: track.name,
    subtitle: artist.name,
    spotifyTrackId: track.id,
    primaryArtistId: artist.id,
    primaryArtistName: artist.name,
    ...(track.albumId ? { albumId: track.albumId } : {}),
    ...(track.albumName ? { albumName: track.albumName } : {}),
    durationMs: track.durationMs,
  };
  return {
    candidateKey: `liked:${source.candidateKey}`,
    candidate,
    rawScore: source.scoreCard.score,
    adjustedScore: calibratedScore,
    historyClass: "LIKED_SIMILAR_EXPLORATORY_NEW",
    pathLabel: "LIKED_SIMILAR_EXPLORATORY",
    resolutionReason: resolution.reason,
    isrc: track.isrc,
  };
}

export function likedDiscoveryPilotTargetIds(
  value: string | null | undefined = process.env.LIKED_DISCOVERY_PILOT_TARGET_IDS,
): ReadonlySet<string> {
  return parseTargetIds(value);
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
  if (!input.pilot) {
    return { discoveries: [...input.standard], duplicateSuppressed: false };
  }
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

function disabled(
  targetIds: ReadonlySet<string>,
  evidence: LikedDiscoveryPilotEvidence,
  reason: string,
): LikedDiscoveryPilotResolution {
  return {
    discovery: null,
    targetIds,
    evidence: { ...evidence, status: "DISABLED", reason },
  };
}

function abstained(
  targetIds: ReadonlySet<string>,
  evidence: LikedDiscoveryPilotEvidence,
  reason: string,
  error: unknown,
): LikedDiscoveryPilotResolution {
  return {
    discovery: null,
    targetIds,
    evidence: {
      ...evidence,
      status: "ABSTAINED",
      reason,
      failure: error instanceof Error ? error.message : String(error),
    },
  };
}

function evidenceBase(
  policy: ReturnType<typeof resolveLikedDiscoveryPilotPolicy>,
): LikedDiscoveryPilotEvidence {
  return {
    policyVersion: LIKED_DISCOVERY_PILOT_RUNTIME_POLICY.version,
    status: "DISABLED",
    reason: policy.reason,
    enabled: policy.enabled,
    userAllowlisted:
      policy.reason === "ENABLED" || policy.reason === "TARGET_ALLOWLIST_EMPTY",
    targetAllowlistSize: policy.targetIds.size,
    calibrationReadiness: null,
    calibrationReasons: [],
    sourceGeneratedAt: null,
    ambiguityRate: null,
    spotifyCatalogCalls: 0,
    spotifyFailures: 0,
    spotifyRateLimits: 0,
    spotifyRetries: 0,
    revalidationSpotifyCatalogCalls: 0,
    revalidationSpotifyFailures: 0,
    revalidationSpotifyRateLimits: 0,
    revalidationSpotifyRetries: 0,
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

function evidenceWithRevalidationMetrics(
  evidence: LikedDiscoveryPilotEvidence,
  metrics: ReturnType<SpotifyCatalogSearchClient["getMetrics"]>,
): LikedDiscoveryPilotEvidence {
  return {
    ...evidence,
    revalidationSpotifyCatalogCalls: metrics.totalCalls,
    revalidationSpotifyFailures: metrics.failures,
    revalidationSpotifyRateLimits: metrics.rateLimitedCount,
    revalidationSpotifyRetries: metrics.retries,
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
