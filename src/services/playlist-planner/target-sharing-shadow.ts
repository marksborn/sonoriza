export type EffectiveSharingPolicy = "EXCLUSIVE" | "SHAREABLE";

export type SharingPolicyOverrideValue =
  | "INHERIT_GLOBAL"
  | EffectiveSharingPolicy;

/**
 * TARGET-SCOPE-01 Gate 4:
 * until the product-level global preference is exposed/persisted, inheritance
 * deliberately resolves to the exact legacy planner behavior.
 */
export const LEGACY_GLOBAL_SHARING_POLICY: EffectiveSharingPolicy = "EXCLUSIVE";

export function resolveEffectiveSharingPolicy(
  override: SharingPolicyOverrideValue,
  globalPolicy: EffectiveSharingPolicy = LEGACY_GLOBAL_SHARING_POLICY,
): EffectiveSharingPolicy {
  return override === "INHERIT_GLOBAL" ? globalPolicy : override;
}

/**
 * Symmetric product rule:
 * an URI may be shared only when every destination involved opts into SHAREABLE.
 */
export function sharingPoliciesConflict(
  left: EffectiveSharingPolicy,
  right: EffectiveSharingPolicy,
): boolean {
  return !(left === "SHAREABLE" && right === "SHAREABLE");
}

export type TargetSharingShadowTargetEvidence = {
  targetPlaylistId: string;
  targetName: string;
  effectiveSharingPolicy: EffectiveSharingPolicy;
  legacyReservedCandidateCount: number;
  effectiveConflictCandidateCount: number;
  wouldBeShareableCandidateCount: number;
  conflictingTargetIds: string[];
  shareableTargetIds: string[];
};

export type TargetSharingShadowEvidence = {
  gate: 4;
  mode: "SHADOW";
  plannerInfluence: false;
  globalPolicy: EffectiveSharingPolicy;
  legacyReservedCandidateCount: number;
  effectiveConflictCandidateCount: number;
  wouldBeShareableCandidateCount: number;
  targets: TargetSharingShadowTargetEvidence[];
};

export type ReservationShadowCandidate = {
  uri: string;
};

export function analyzeLegacyReservationForTarget(input: {
  targetPlaylistId: string;
  targetName: string;
  effectiveSharingPolicy: EffectiveSharingPolicy;
  candidates: readonly ReservationShadowCandidate[];
  reservedOwnersByUri: ReadonlyMap<string, ReadonlySet<string>>;
  sharingPolicyByTargetId: ReadonlyMap<string, EffectiveSharingPolicy>;
}): TargetSharingShadowTargetEvidence {
  const seenUris = new Set<string>();
  const conflictingTargetIds = new Set<string>();
  const shareableTargetIds = new Set<string>();

  let legacyReservedCandidateCount = 0;
  let effectiveConflictCandidateCount = 0;
  let wouldBeShareableCandidateCount = 0;

  for (const candidate of input.candidates) {
    if (seenUris.has(candidate.uri)) continue;
    seenUris.add(candidate.uri);

    const owners = input.reservedOwnersByUri.get(candidate.uri);
    if (!owners || owners.size === 0) continue;

    legacyReservedCandidateCount += 1;

    let conflicts = false;

    for (const ownerTargetId of owners) {
      if (ownerTargetId === input.targetPlaylistId) continue;

      const ownerPolicy =
        input.sharingPolicyByTargetId.get(ownerTargetId) ??
        LEGACY_GLOBAL_SHARING_POLICY;

      if (
        sharingPoliciesConflict(
          input.effectiveSharingPolicy,
          ownerPolicy,
        )
      ) {
        conflicts = true;
        conflictingTargetIds.add(ownerTargetId);
      } else {
        shareableTargetIds.add(ownerTargetId);
      }
    }

    if (conflicts) {
      effectiveConflictCandidateCount += 1;
    } else {
      wouldBeShareableCandidateCount += 1;
    }
  }

  return {
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    effectiveSharingPolicy: input.effectiveSharingPolicy,
    legacyReservedCandidateCount,
    effectiveConflictCandidateCount,
    wouldBeShareableCandidateCount,
    conflictingTargetIds: [...conflictingTargetIds].sort(),
    shareableTargetIds: [...shareableTargetIds].sort(),
  };
}

export function buildTargetSharingShadowEvidence(input: {
  targets: TargetSharingShadowTargetEvidence[];
  globalPolicy?: EffectiveSharingPolicy;
}): TargetSharingShadowEvidence {
  return {
    gate: 4,
    mode: "SHADOW",
    plannerInfluence: false,
    globalPolicy:
      input.globalPolicy ?? LEGACY_GLOBAL_SHARING_POLICY,
    legacyReservedCandidateCount: input.targets.reduce(
      (sum, target) => sum + target.legacyReservedCandidateCount,
      0,
    ),
    effectiveConflictCandidateCount: input.targets.reduce(
      (sum, target) => sum + target.effectiveConflictCandidateCount,
      0,
    ),
    wouldBeShareableCandidateCount: input.targets.reduce(
      (sum, target) => sum + target.wouldBeShareableCandidateCount,
      0,
    ),
    targets: input.targets,
  };
}
