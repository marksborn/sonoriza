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
  | "ABSTAIN_GLOBAL_ACTIVE_GATE_NOT_ENABLED"
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
   * Legacy single-target Gate 4 seam. Explicit GLOBAL never populates this set,
   * so the old shared-pool filter cannot leak one target's cooldown to another.
   */
  blockedTrackIds: ReadonlySet<string>;
  /** Gate 1 projection for the target-aware planner seam introduced in #343. */
  projectedBlockedTrackIdsByTargetId: ReadonlyMap<string, ReadonlySet<string>>;
  /** Productive subset. GLOBAL remains empty until a later approved gate wires it. */
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
    | "ABSTAIN_GLOBAL_ACTIVE_GATE_NOT_ENABLED"
    | "ABSTAIN_USER_NOT_ALLOWLISTED"
    | "ABSTAIN_SINGLE_TARGET_SCOPE_REQUIRED"
    | "ABSTAIN_TARGET_NOT_ALLOWLISTED";
  targetPlaylistIds: readonly string[];
  legacySingleTargetFilterAllowed: boolean;
}>;

/**
 * #343 Gate 1 scope contract.
 *
 * Missing SCOPE deliberately means legacy ALLOWLIST, not GLOBAL. This preserves
 * the already-deployed single-target pilot after code deployment. GLOBAL is an
 * explicit opt-in and, in this gate, is shadow-only: ACTIVE global influence is
 * fail-closed until the target-aware planner wiring is separately approved.
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
 * Gate 4 compatibility boundary plus #343 Gate 1 scope validation.
 *
 * ALLOWLIST intentionally retains the exact single-target productive rule in
 * Gate 1. That prevents a deployment of this branch from expanding the current
 * pilot merely because SCOPE was added. GLOBAL may be observed in SHADOW, but
 * productive GLOBAL activation is deliberately refused by this gate.
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

  if (scopeConfig.scope === "GLOBAL") {
    return {
      allowed: false,
      status: "ABSTAIN_GLOBAL_ACTIVE_GATE_NOT_ENABLED",
      targetPlaylistIds: normalizeTargetIds(input.targetPlaylistIds),
      legacySingleTargetFilterAllowed: false,
    };
  }

  const targetPlaylistIds = normalizeTargetIds(input.targetPlaylistIds);
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
    // Both implicit legacy scope and explicit ALLOWLIST remain equivalent in
    // Gate 1: one target only, so the existing shared candidate filter is safe.
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
    const blockedTrackIdsByTargetId = new Map<string, ReadonlySet<string>>();

    if (productiveInfluenceAllowed && activeDecision) {
      for (const targetPlaylistId of activeDecision.targetPlaylistIds) {
        const ids = projectedBlockedTrackIdsByTargetId.get(targetPlaylistId);
        if (ids?.size) blockedTrackIdsByTargetId.set(targetPlaylistId, ids);
      }
    }

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

/** Legacy single-target candidate seam retained for the existing Gate 4 pilot. */
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

/**
 * #343 Gate 1 target-aware seam. This is safe to wire in a later gate because
 * the blocked set is selected only from the requested target's own anchors.
 */
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
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (entry.includes("@") ? entry.toLowerCase() : entry)),
  );
}
