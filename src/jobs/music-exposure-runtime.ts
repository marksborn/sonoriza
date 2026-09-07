import type { Candidate } from "@/services/playlist-planner";
import {
  buildMusicExposureEligibilityProjection,
  filterMusicCandidatesForExposureEligibility,
  type MusicExposureEligibilityProjection,
} from "@/services/music-exposure/eligibility-anchor";
import { readMusicExposureModel } from "@/services/music-exposure/read-model";

export type Music07EligibilityMode = "OFF" | "SHADOW" | "ACTIVE";

export type Music07EligibilityRuntimeStatus =
  | "OFF"
  | "READY_SHADOW"
  | "READY_ACTIVE"
  | "ABSTAIN_USER_NOT_ALLOWLISTED"
  | "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED"
  | "ABSTAIN_TARGET_NOT_ALLOWLISTED"
  | "ABSTAIN_POLICY_DISABLED"
  | "ABSTAIN_POLICY_INCOMPLETE"
  | "ABSTAIN_LASTFM_INCOMPLETE"
  | "ABSTAIN_PREPARATION_FAILED";

export type Music07EligibilityRuntimeState = {
  configuredMode: Music07EligibilityMode;
  effectiveMode: Music07EligibilityMode;
  productiveInfluenceAllowed: boolean;
  status: Music07EligibilityRuntimeStatus;
  projection: MusicExposureEligibilityProjection | null;
  blockedTrackIds: ReadonlySet<string>;
  exposureCooldownSkippedCount: number;
  diagnostics: Record<string, unknown>;
};

export type Music07ActiveScopeDecision = Readonly<{
  allowed: boolean;
  status:
    | "READY_ACTIVE"
    | "ABSTAIN_USER_NOT_ALLOWLISTED"
    | "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED"
    | "ABSTAIN_TARGET_NOT_ALLOWLISTED";
}>;

/**
 * Gate 4 safety boundary. Exposure anchors are target-specific, so productive
 * eligibility is deliberately limited to exactly one target per run. This
 * prevents a cooldown derived in one target from leaking into another target's
 * candidate pool during a mixed scoped generation.
 */
export function evaluateMusic07ActiveScope(input: {
  userEmail: string | null;
  targetPlaylistIds: readonly string[] | null;
  allowedEmails: ReadonlySet<string>;
  allowedTargetIds: ReadonlySet<string>;
}): Music07ActiveScopeDecision {
  if (!input.userEmail || !input.allowedEmails.has(input.userEmail.toLowerCase())) {
    return { allowed: false, status: "ABSTAIN_USER_NOT_ALLOWLISTED" };
  }

  const targetPlaylistIds = input.targetPlaylistIds
    ? [...new Set(input.targetPlaylistIds.filter(Boolean))]
    : [];
  if (targetPlaylistIds.length !== 1) {
    return { allowed: false, status: "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED" };
  }
  if (!input.allowedTargetIds.has(targetPlaylistIds[0]!)) {
    return { allowed: false, status: "ABSTAIN_TARGET_NOT_ALLOWLISTED" };
  }
  return { allowed: true, status: "READY_ACTIVE" };
}

export async function prepareMusic07EligibilityRuntime(input: {
  userId: string;
  userEmail: string | null;
  asOf: Date;
  targetPlaylistIds: readonly string[] | null;
  modeOverride?: Music07EligibilityMode;
}): Promise<Music07EligibilityRuntimeState> {
  const configuredMode = input.modeOverride ?? configuredModeFromEnv();
  if (configuredMode === "OFF") return offState(configuredMode);

  let productiveInfluenceAllowed = false;
  let status: Music07EligibilityRuntimeStatus = "READY_SHADOW";

  if (configuredMode === "ACTIVE") {
    const scopeDecision = evaluateMusic07ActiveScope({
      userEmail: input.userEmail,
      targetPlaylistIds: input.targetPlaylistIds,
      allowedEmails: csvSet(process.env.MUSIC_07_ELIGIBILITY_EMAIL_ALLOWLIST),
      allowedTargetIds: csvSet(process.env.MUSIC_07_ELIGIBILITY_TARGET_IDS),
    });
    productiveInfluenceAllowed = scopeDecision.allowed;
    status = scopeDecision.status;
  }

  try {
    const readModel = await readMusicExposureModel({
      userId: input.userId,
      to: input.asOf,
      threshold: 4,
      maxPages: 10,
      targetPlaylistIds: input.targetPlaylistIds,
    });
    const projection = buildMusicExposureEligibilityProjection({
      report: readModel.report,
      scrobbles: readModel.scrobbles,
      lastFmComplete: readModel.diagnostics.lastFmComplete,
      policy: readModel.policy,
      asOf: input.asOf,
    });

    if (projection.status === "POLICY_DISABLED") {
      productiveInfluenceAllowed = false;
      status = "ABSTAIN_POLICY_DISABLED";
    } else if (projection.status === "POLICY_INCOMPLETE") {
      productiveInfluenceAllowed = false;
      status = "ABSTAIN_POLICY_INCOMPLETE";
    } else if (projection.status === "LASTFM_INCOMPLETE") {
      productiveInfluenceAllowed = false;
      status = "ABSTAIN_LASTFM_INCOMPLETE";
    }

    return {
      configuredMode,
      effectiveMode: productiveInfluenceAllowed ? "ACTIVE" : "SHADOW",
      productiveInfluenceAllowed,
      status,
      projection,
      blockedTrackIds: productiveInfluenceAllowed
        ? projection.activeTrackIds
        : new Set<string>(),
      exposureCooldownSkippedCount: 0,
      diagnostics: {
        source: "SONORIZA_EXPOSURE",
        trackExposureStorage: "DERIVED_GENERATION_LEDGER",
        transactionReadOnly: readModel.diagnostics.transactionReadOnly,
        realRunCount: readModel.diagnostics.realRunCount,
        identityReadyItemCount: readModel.diagnostics.identityReadyItemCount,
        measurableTargetSnapshotCount:
          readModel.diagnostics.measurableTargetSnapshotCount,
        lastFmStatus: readModel.diagnostics.lastFmStatus,
        lastFmComplete: readModel.diagnostics.lastFmComplete,
        lastFmScrobbleCount: readModel.diagnostics.lastFmScrobbleCount,
        anchorCount: projection.anchors.length,
        activeAnchorCount: projection.activeAnchors.length,
      },
    };
  } catch (error) {
    return {
      configuredMode,
      effectiveMode: "SHADOW",
      productiveInfluenceAllowed: false,
      status: "ABSTAIN_PREPARATION_FAILED",
      projection: null,
      blockedTrackIds: new Set<string>(),
      exposureCooldownSkippedCount: 0,
      diagnostics: {
        source: "SONORIZA_EXPOSURE",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function applyMusic07EligibilityToCandidates(
  candidates: Candidate[],
  state: Music07EligibilityRuntimeState,
): Candidate[] {
  const filtered = filterMusicCandidatesForExposureEligibility(
    candidates,
    state.blockedTrackIds,
    state.productiveInfluenceAllowed,
  );
  state.exposureCooldownSkippedCount += filtered.exposureCooldownSkippedCount;
  return filtered.candidates;
}

export function music07EligibilityRuntimeSummary(
  state: Music07EligibilityRuntimeState,
): Record<string, unknown> {
  return {
    configuredMode: state.configuredMode,
    effectiveMode: state.effectiveMode,
    productiveInfluenceAllowed: state.productiveInfluenceAllowed,
    status: state.status,
    source: "SONORIZA_EXPOSURE",
    anchorSemantic: "eligibilityAnchorAt",
    lastPlayedAtWritten: false,
    blockedTrackCount: state.blockedTrackIds.size,
    exposureCooldownSkippedCount: state.exposureCooldownSkippedCount,
    diagnostics: state.diagnostics,
  };
}

export function offMusic07EligibilityRuntimeState(): Music07EligibilityRuntimeState {
  return offState("OFF");
}

function offState(configuredMode: Music07EligibilityMode): Music07EligibilityRuntimeState {
  return {
    configuredMode,
    effectiveMode: "OFF",
    productiveInfluenceAllowed: false,
    status: "OFF",
    projection: null,
    blockedTrackIds: new Set<string>(),
    exposureCooldownSkippedCount: 0,
    diagnostics: {
      source: "SONORIZA_EXPOSURE",
      providerCalls: "NONE",
      databaseReads: "NONE",
    },
  };
}

function configuredModeFromEnv(): Music07EligibilityMode {
  const raw = process.env.MUSIC_07_ELIGIBILITY_MODE?.trim().toUpperCase();
  if (!raw) return "OFF";
  if (raw === "OFF" || raw === "SHADOW" || raw === "ACTIVE") return raw;
  return "OFF";
}

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (entry.includes("@") ? entry.toLowerCase() : entry)),
  );
}
