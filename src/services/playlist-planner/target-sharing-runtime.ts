import type {
  EffectiveSharingPolicy,
} from "./target-sharing-shadow";
import {
  LEGACY_GLOBAL_SHARING_POLICY,
  sharingPoliciesConflict,
} from "./target-sharing-shadow";

export type TargetSharingReservationOwner = {
  targetPlaylistId: string;
  sharingPolicy: EffectiveSharingPolicy;
};

export type TargetSharingReservationMap =
  ReadonlyMap<string, readonly TargetSharingReservationOwner[]>;

export type TargetSharingRuntimeEvidence = {
  gate: 5;
  mode: "ACTIVE";
  plannerInfluence: true;
  legacyHardReservedCount: number;
  ownedReservationUriCount: number;
  targets: Array<{
    targetPlaylistId: string;
    targetName: string;
    effectiveSharingPolicy: EffectiveSharingPolicy;
    blockedByPolicyCount: number;
    shareableReservationCount: number;
    conflictingTargetIds: string[];
  }>;
};

export type TargetSharingViolation = {
  uri: string;
  leftTargetPlaylistId: string;
  leftTargetName: string;
  leftPolicy: EffectiveSharingPolicy;
  rightTargetPlaylistId: string;
  rightTargetName: string | null;
  rightPolicy: EffectiveSharingPolicy;
  source: "PLANNED_TARGET" | "EXTERNAL_TARGET";
};

export function reservationsForTarget(input: {
  targetPlaylistId: string;
  effectiveSharingPolicy: EffectiveSharingPolicy;
  legacyHardReserved?: Iterable<string>;
  reservationsByUri: TargetSharingReservationMap;
}): {
  forbiddenUris: Set<string>;
  blockedByPolicyCount: number;
  shareableReservationCount: number;
  conflictingTargetIds: string[];
} {
  const forbiddenUris = new Set(input.legacyHardReserved ?? []);
  const conflictingTargetIds = new Set<string>();
  let blockedByPolicyCount = 0;
  let shareableReservationCount = 0;

  for (const [uri, owners] of input.reservationsByUri) {
    let conflict = false;
    let hasOtherOwner = false;

    for (const owner of owners) {
      if (owner.targetPlaylistId === input.targetPlaylistId) continue;
      hasOtherOwner = true;

      if (
        sharingPoliciesConflict(
          input.effectiveSharingPolicy,
          owner.sharingPolicy,
        )
      ) {
        conflict = true;
        conflictingTargetIds.add(owner.targetPlaylistId);
      }
    }

    if (!hasOtherOwner) continue;

    if (conflict) {
      if (!forbiddenUris.has(uri)) blockedByPolicyCount += 1;
      forbiddenUris.add(uri);
    } else {
      shareableReservationCount += 1;
    }
  }

  return {
    forbiddenUris,
    blockedByPolicyCount,
    shareableReservationCount,
    conflictingTargetIds: [...conflictingTargetIds].sort(),
  };
}

export function addTargetReservations(input: {
  targetPlaylistId: string;
  sharingPolicy: EffectiveSharingPolicy;
  uris: Iterable<string>;
  reservationsByUri: Map<string, TargetSharingReservationOwner[]>;
}): void {
  for (const uri of input.uris) {
    const owners = input.reservationsByUri.get(uri) ?? [];

    if (
      !owners.some(
        (owner) => owner.targetPlaylistId === input.targetPlaylistId,
      )
    ) {
      owners.push({
        targetPlaylistId: input.targetPlaylistId,
        sharingPolicy: input.sharingPolicy,
      });
    }

    input.reservationsByUri.set(uri, owners);
  }
}

export function cloneReservationMap(
  input?: TargetSharingReservationMap,
): Map<string, TargetSharingReservationOwner[]> {
  return new Map(
    [...(input ?? new Map()).entries()].map(([uri, owners]) => [
      uri,
      owners.map((owner: TargetSharingReservationOwner) => ({ ...owner })),
    ]),
  );
}

export function findTargetSharingViolations(input: {
  targets: Array<{
    targetPlaylistId: string;
    name: string;
    uris: Iterable<string>;
  }>;
  sharingPolicyByTargetId: ReadonlyMap<string, EffectiveSharingPolicy>;
  externalReservationsByUri?: TargetSharingReservationMap;
}): TargetSharingViolation[] {
  const violations: TargetSharingViolation[] = [];
  const plannedOwnersByUri = new Map<
    string,
    Array<{
      targetPlaylistId: string;
      targetName: string;
      sharingPolicy: EffectiveSharingPolicy;
    }>
  >();

  for (const target of input.targets) {
    const policy =
      input.sharingPolicyByTargetId.get(target.targetPlaylistId) ??
      LEGACY_GLOBAL_SHARING_POLICY;

    for (const uri of new Set(target.uris)) {
      const plannedOwners = plannedOwnersByUri.get(uri) ?? [];

      for (const owner of plannedOwners) {
        if (!sharingPoliciesConflict(policy, owner.sharingPolicy)) continue;

        violations.push({
          uri,
          leftTargetPlaylistId: target.targetPlaylistId,
          leftTargetName: target.name,
          leftPolicy: policy,
          rightTargetPlaylistId: owner.targetPlaylistId,
          rightTargetName: owner.targetName,
          rightPolicy: owner.sharingPolicy,
          source: "PLANNED_TARGET",
        });
      }

      for (const owner of input.externalReservationsByUri?.get(uri) ?? []) {
        if (owner.targetPlaylistId === target.targetPlaylistId) continue;
        if (!sharingPoliciesConflict(policy, owner.sharingPolicy)) continue;

        violations.push({
          uri,
          leftTargetPlaylistId: target.targetPlaylistId,
          leftTargetName: target.name,
          leftPolicy: policy,
          rightTargetPlaylistId: owner.targetPlaylistId,
          rightTargetName: null,
          rightPolicy: owner.sharingPolicy,
          source: "EXTERNAL_TARGET",
        });
      }

      plannedOwners.push({
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.name,
        sharingPolicy: policy,
      });
      plannedOwnersByUri.set(uri, plannedOwners);
    }
  }

  return violations;
}
