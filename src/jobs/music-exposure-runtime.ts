import type { Candidate } from "@/services/playlist-planner";
import {
  buildMusicExposureEligibilityProjection,
  filterMusicCandidatesForExposureEligibility,
  type MusicExposureEligibilityProjection,
} from "@/services/music-exposure/eligibility-anchor";
import { readMusicExposureModel } from "@/services/music-exposure/read-model";

export type Music07EligibilityMode = "OFF" | "SHADOW" | "ACTIVE";
export type Music07EligibilityScope = "ALLOWLIST" | "GLOBAL";

export type Music07EligibilityRuntimeStatus =
  | "OFF"
  | "READY_SHADOW"
  | "READY_ACTIVE"
  | "ABSTAIN_SCOPE_INVALID"
  | "ABSTAIN_USER_NOT_ALLOWLISTED"
  | "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED"
  | "ABSTAIN_TARGET_NOT_ALLOWLISTED"
  | "ABSTAIN_POLICY_DISABLED"
  | "ABSTAIN_POLICY_INCOMPLETE"
  | "ABSTAIN_LASTFM_INCOMPLETE"
  | "ABSTAIN_PREPARATION_FAILED";

export type Music07EligibilityScopeConfig = Readonly<{
  scope: Music07EligibilityScope;
  explicit: boolean;
  valid: boolean;
  raw: string | null;
}>;

export type Music07EligibilityRuntimeState = {
  configuredMode: Music07EligibilityMode;
  configuredScope: Music07EligibilityScope;
  scopeExplicit: boolean;
  effectiveMode: Music07EligibilityMode;
  productiveInfluenceAllowed: boolean;
  status: Music07EligibilityRuntimeStatus;
  projection: MusicExposureEligibilityProjection | null;
  /**
   * Legacy single-target seam. GLOBAL intentionally leaves this empty so the
   * shared-pool filter can never union cooldowns from different targets.
   */
  blockedTrackIds: ReadonlySet<string>;
  /** Target-local projection derived from active SONORIZA_EXPOSURE anchors. */
  projectedBlockedTrackIdsByTargetId: ReadonlyMap<string, ReadonlySet<string>>;
  /** Productive target-local subset authorized by the current rollout scope. */
  blockedTrackIdsByTargetId: ReadonlyMap<string, ReadonlySet<string>>;
  exposureCooldownSkippedCount: number;
  exposureCooldownSkippedCountByTargetId: Map<string, number>;
  diagnostics: Record<string, unknown>;
};

export type Music07ActiveScopeDecision = Readonly<{
  allowed: boolean;
  status:
    | "READY_ACTIVE"
    | "ABSTAIN_SCOPE_INVALID"
    | "ABSTAIN_USER_NOT_ALLOWLISTED"
    | "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED"
    | "ABSTAIN_TARGET_NOT_ALLOWLISTED";
  /** Empty under GLOBAL means all targets represented by the runtime projection. */
  targetPlaylistIds: readonly string[];
  legacySingleTargetFilterAllowed: boolean;
}>;

/**
 * #343 rollout scope contract.
 *
 * Missing SCOPE deliberately means legacy ALLOWLIST, never GLOBAL. GLOBAL is
 * always an explicit opt-in; an empty TARGET_IDS list therefore cannot expand
 * rollout by itself.
 */
export function resolveMusic07EligibilityScope(
  value: string | undefined,
): Music07EligibilityScopeConfig {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return { scope: "ALLOWLIST", explicit: false, valid: true, raw: null };
  }

  const normalized = raw.toUpperCase();
  if (normalized === "ALLOWLIST" || normalized === "GLOBAL") {
    return {
      scope: normalized,
      explicit: true,
      valid: true,
      raw,
    };
  }

  return {
    scope: "ALLOWLIST",
    explicit: true,
    valid: false,
    raw,
  };
}

/**
 * #343 Gate 4 active scope decision.
 *
 * ALLOWLIST preserves the original single-target productive guard. GLOBAL is
 * productive only when explicitly selected and the user is allowlisted. Target
 * isolation is enforced later by blockedTrackIdsByTargetId; the legacy shared
 * filter stays disabled for GLOBAL.
 */
export function evaluateMusic07ActiveScope(input: {
  userEmail: string | null;
  targetPlaylistIds: readonly string[] | null;
  allowedEmails: ReadonlySet<string>;
  allowedTargetIds: ReadonlySet<string>;
  scopeConfig?: Music07EligibilityScopeConfig;
}): Music07ActiveScopeDecision {
  const scopeConfig =
    input.scopeConfig ?? resolveMusic07EligibilityScope(undefined);

  if (!scopeConfig.valid) {
    return {
      allowed: false,
      status: "ABSTAIN_SCOPE_INVALID",
      targetPlaylistIds: [],
      legacySingleTargetFilterAllowed: false,
    };
  }

  if (!input.userEmail || !input.allowedEmails.has(input.userEmail.toLowerCase())) {
    return {
      allowed: false,
      status: "ABSTAIN_USER_NOT_ALLOWLISTED",
      targetPlaylistIds: [],
      legacySingleTargetFilterAllowed: false,
    };
  }

  const targetPlaylistIds = normalizeTargetIds(input.targetPlaylistIds);

  if (scopeConfig.scope === "GLOBAL") {
    return {
      allowed: true,
      status: "READY_ACTIVE",
      targetPlaylistIds,
      legacySingleTargetFilterAllowed: false,
    };
  }

  if (targetPlaylistIds.length !== 1) {
    return {
      allowed: false,
      status: "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED",
      targetPlaylistIds: [],
      legacySingleTargetFilterAllowed: false,
    };
  }
  if (!input.allowedTargetIds.has(targetPlaylistIds[0]!)) {
    return {
      allowed: false,
      status: "ABSTAIN_TARGET_NOT_ALLOWLISTED",
      targetPlaylistIds: [],
      legacySingleTargetFilterAllowed: false,
    };
  }
  return {
    allowed: true,
    status: "READY_ACTIVE",
    targetPlaylistIds,
    // Implicit legacy scope and explicit ALLOWLIST remain equivalent: one
    // target only, so the existing shared candidate filter is safe.
    legacySingleTargetFilterAllowed: true,
  };
}

export function groupMusic07ActiveTrackIdsByTarget(
  projection: MusicExposureEligibilityProjection,
): Map<string, ReadonlySet<string>> {
  const mutable = new Map<string, Set<string>>();
  for (const anchor of projection.activeAnchors) {
    const bucket = mutable.get(anchor.targetPlaylistId) ?? new Set<string>();
    bucket.add(anchor.spotifyTrackId);
    mutable.set(anchor.targetPlaylistId, bucket);
  }
  return new Map(mutable);
}

/**
 * Selects the productive target-local blocked sets authorized by the rollout.
 * GLOBAL + no explicit target scope means every target represented by the
 * projection. A scoped scheduled run only receives the requested targets.
 */
export function selectMusic07ProductiveBlockedTrackIdsByTarget(
  projected: ReadonlyMap<string, ReadonlySet<string>>,
  activeDecision: Music07ActiveScopeDecision | null,
  scope: Music07EligibilityScope,
): Map<string, ReadonlySet<string>> {
  const selected = new Map<string, ReadonlySet<string>>();
  if (!activeDecision?.allowed) return selected;

  const targetPlaylistIds =
    scope === "GLOBAL" && activeDecision.targetPlaylistIds.length === 0
      ? [...projected.keys()]
      : activeDecision.targetPlaylistIds;

  for (const targetPlaylistId of targetPlaylistIds) {
    const ids = projected.get(targetPlaylistId);
    if (ids?.size) selected.set(targetPlaylistId, ids);
  }

  return selected;
}

export async function prepareMusic07EligibilityRuntime(input: {
  userId: string;
  userEmail: string | null;
  asOf: Date;
  targetPlaylistIds: readonly string[] | null;
  modeOverride?: Music07EligibilityMode;
  scopeOverride?: Music07EligibilityScopeConfig;
}): Promise<Music07EligibilityRuntimeState> {
  const configuredMode = input.modeOverride ?? configuredModeFromEnv();
  const scopeConfig =
    input.scopeOverride ??
    resolveMusic07EligibilityScope(process.env.MUSIC_07_ELIGIBILITY_SCOPE);

  if (configuredMode === "OFF") return offState(configuredMode, scopeConfig);
  if (!scopeConfig.valid) {
    return abstainedState(
      configuredMode,
      scopeConfig,
      "ABSTAIN_SCOPE_INVALID",
      {
        source: "SONORIZA_EXPOSURE",
        invalidScope: scopeConfig.raw,
        providerCalls: "NONE",
        databaseReads: "NONE",
      },
    );
  }

  let productiveInfluenceAllowed = false;
  let status: Music07EligibilityRuntimeStatus = "READY_SHADOW";
  let activeDecision: Music07ActiveScopeDecision | null = null;

  if (configuredMode === "ACTIVE") {
    activeDecision = evaluateMusic07ActiveScope({
      userEmail: input.userEmail,
      targetPlaylistIds: input.targetPlaylistIds,
      allowedEmails: csvSet(process.env.MUSIC_07_ELIGIBILITY_EMAIL_ALLOWLIST),
      allowedTargetIds: csvSet(process.env.MUSIC_07_ELIGIBILITY_TARGET_IDS),
      scopeConfig,
    });
    productiveInfluenceAllowed = activeDecision.allowed;
    status = activeDecision.status;
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

    const projectedBlockedTrackIdsByTargetId =
      groupMusic07ActiveTrackIdsByTarget(projection);
    const blockedTrackIdsByTargetId = productiveInfluenceAllowed
      ? selectMusic07ProductiveBlockedTrackIdsByTarget(
          projectedBlockedTrackIdsByTargetId,
          activeDecision,
          scopeConfig.scope,
        )
      : new Map<string, ReadonlySet<string>>();

    const legacyBlockedTrackIds =
      productiveInfluenceAllowed &&
      activeDecision?.legacySingleTargetFilterAllowed &&
      activeDecision.targetPlaylistIds.length === 1
        ? blockedTrackIdsByTargetId.get(activeDecision.targetPlaylistIds[0]!) ??
          new Set<string>()
        : new Set<string>();

    return {
      configuredMode,
      configuredScope: scopeConfig.scope,
      scopeExplicit: scopeConfig.explicit,
      effectiveMode: productiveInfluenceAllowed ? "ACTIVE" : "SHADOW",
      productiveInfluenceAllowed,
      status,
      projection,
      blockedTrackIds: legacyBlockedTrackIds,
      projectedBlockedTrackIdsByTargetId,
      blockedTrackIdsByTargetId,
      exposureCooldownSkippedCount: 0,
      exposureCooldownSkippedCountByTargetId: new Map<string, number>(),
      diagnostics: {
        source: "SONORIZA_EXPOSURE",
        configuredScope: scopeConfig.scope,
        scopeExplicit: scopeConfig.explicit,
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
        targets: music07TargetDiagnostics(
          projection,
          blockedTrackIdsByTargetId,
          new Map<string, number>(),
        ),
      },
    };
  } catch (error) {
    return abstainedState(
      configuredMode,
      scopeConfig,
      "ABSTAIN_PREPARATION_FAILED",
      {
        source: "SONORIZA_EXPOSURE",
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/** Legacy single-target candidate seam retained for ALLOWLIST compatibility. */
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

/** Target-aware productive seam used by GLOBAL and target-local planning. */
export function applyMusic07EligibilityToCandidatesForTarget(
  targetPlaylistId: string,
  candidates: Candidate[],
  state: Music07EligibilityRuntimeState,
): Candidate[] {
  const blockedTrackIds =
    state.blockedTrackIdsByTargetId.get(targetPlaylistId) ?? new Set<string>();
  const filtered = filterMusicCandidatesForExposureEligibility(
    candidates,
    blockedTrackIds,
    state.productiveInfluenceAllowed,
  );
  if (filtered.exposureCooldownSkippedCount > 0) {
    const next =
      (state.exposureCooldownSkippedCountByTargetId.get(targetPlaylistId) ?? 0) +
      filtered.exposureCooldownSkippedCount;
    state.exposureCooldownSkippedCountByTargetId.set(targetPlaylistId, next);
    state.exposureCooldownSkippedCount += filtered.exposureCooldownSkippedCount;
  }
  return filtered.candidates;
}

export function music07EligibilityRuntimeSummary(
  state: Music07EligibilityRuntimeState,
): Record<string, unknown> {
  return {
    configuredMode: state.configuredMode,
    configuredScope: state.configuredScope,
    scopeExplicit: state.scopeExplicit,
    effectiveMode: state.effectiveMode,
    productiveInfluenceAllowed: state.productiveInfluenceAllowed,
    status: state.status,
    source: "SONORIZA_EXPOSURE",
    anchorSemantic: "eligibilityAnchorAt",
    lastPlayedAtWritten: false,
    blockedTrackCount: state.blockedTrackIdsByTargetId.size
      ? [...state.blockedTrackIdsByTargetId.values()].reduce(
          (sum, ids) => sum + ids.size,
          0,
        )
      : state.blockedTrackIds.size,
    exposureCooldownSkippedCount: state.exposureCooldownSkippedCount,
    targets: state.projection
      ? music07TargetDiagnostics(
          state.projection,
          state.blockedTrackIdsByTargetId,
          state.exposureCooldownSkippedCountByTargetId,
        )
      : [],
    diagnostics: state.diagnostics,
  };
}

export function offMusic07EligibilityRuntimeState(): Music07EligibilityRuntimeState {
  return offState("OFF", resolveMusic07EligibilityScope(undefined));
}

function offState(
  configuredMode: Music07EligibilityMode,
  scopeConfig: Music07EligibilityScopeConfig,
): Music07EligibilityRuntimeState {
  return {
    configuredMode,
    configuredScope: scopeConfig.scope,
    scopeExplicit: scopeConfig.explicit,
    effectiveMode: "OFF",
    productiveInfluenceAllowed: false,
    status: "OFF",
    projection: null,
    blockedTrackIds: new Set<string>(),
    projectedBlockedTrackIdsByTargetId: new Map(),
    blockedTrackIdsByTargetId: new Map(),
    exposureCooldownSkippedCount: 0,
    exposureCooldownSkippedCountByTargetId: new Map(),
    diagnostics: {
      source: "SONORIZA_EXPOSURE",
      configuredScope: scopeConfig.scope,
      scopeExplicit: scopeConfig.explicit,
      providerCalls: "NONE",
      databaseReads: "NONE",
    },
  };
}

function abstainedState(
  configuredMode: Music07EligibilityMode,
  scopeConfig: Music07EligibilityScopeConfig,
  status: Music07EligibilityRuntimeStatus,
  diagnostics: Record<string, unknown>,
): Music07EligibilityRuntimeState {
  return {
    configuredMode,
    configuredScope: scopeConfig.scope,
    scopeExplicit: scopeConfig.explicit,
    effectiveMode: "SHADOW",
    productiveInfluenceAllowed: false,
    status,
    projection: null,
    blockedTrackIds: new Set<string>(),
    projectedBlockedTrackIdsByTargetId: new Map(),
    blockedTrackIdsByTargetId: new Map(),
    exposureCooldownSkippedCount: 0,
    exposureCooldownSkippedCountByTargetId: new Map(),
    diagnostics: {
      configuredScope: scopeConfig.scope,
      scopeExplicit: scopeConfig.explicit,
      ...diagnostics,
    },
  };
}

function configuredModeFromEnv(): Music07EligibilityMode {
  const raw = process.env.MUSIC_07_ELIGIBILITY_MODE?.trim().toUpperCase();
  if (!raw) return "OFF";
  if (raw === "OFF" || raw === "SHADOW" || raw === "ACTIVE") return raw;
  return "OFF";
}

function normalizeTargetIds(
  targetPlaylistIds: readonly string[] | null,
): string[] {
  return targetPlaylistIds
    ? [...new Set(targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : [];
}

function music07TargetDiagnostics(
  projection: MusicExposureEligibilityProjection,
  productiveBlockedByTargetId: ReadonlyMap<string, ReadonlySet<string>>,
  skippedByTargetId: ReadonlyMap<string, number>,
): Array<Record<string, unknown>> {
  const targetIds = new Set<string>([
    ...projection.anchors.map((anchor) => anchor.targetPlaylistId),
    ...productiveBlockedByTargetId.keys(),
    ...skippedByTargetId.keys(),
  ]);

  return [...targetIds]
    .sort()
    .map((targetPlaylistId) => {
      const anchors = projection.anchors.filter(
        (anchor) => anchor.targetPlaylistId === targetPlaylistId,
      );
      const activeAnchors = anchors.filter((anchor) => anchor.active);
      return {
        targetPlaylistId,
        targetName: anchors[0]?.targetName ?? null,
        anchorCount: anchors.length,
        activeAnchorCount: activeAnchors.length,
        projectedBlockedTrackCount: new Set(
          activeAnchors.map((anchor) => anchor.spotifyTrackId),
        ).size,
        blockedTrackCount:
          productiveBlockedByTargetId.get(targetPlaylistId)?.size ?? 0,
        exposureCooldownSkippedCount:
          skippedByTargetId.get(targetPlaylistId) ?? 0,
      };
    });
}

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[\n,]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}
