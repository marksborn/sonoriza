import { createHash } from "node:crypto";

import { CanonicalDedupeProjectionStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { resolveTargetSourceScope } from "@/services/target-source-scope";
import {
  runMusicIdentityCanonicalRepresentativeSelectionShadow,
  type Gate4DSelection,
  type MusicIdentityCanonicalRepresentativeSelectionShadowReport,
} from "./canonical-representative-selection-shadow";

export const GATE4E0_POLICY = "LEGACY_FIRST_OCCURRENCE_V1" as const;
export const GATE4E0_CANARY_USER_ID = "cmshwqbpw0000jipbjo70j5nq" as const;
export const GATE4E0_CANARY_TARGET_ID = "cmt4dny9q056xji7hg2a0cj4x" as const;
export const GATE4E0_CANARY_TARGET_NAME = "Avulsa" as const;

export type Gate4E0ActivationComponent = Readonly<{
  componentId: string;
  memberProviderTrackIds: string[];
  representativeProviderTrackId: string;
  preferenceState: string;
  containsExcludedPreference: false;
}>;

export type Gate4E0ActivationProjection = Readonly<{
  gate: "4E0";
  mode: "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_READY";
  userId: string;
  targetPlaylistId: string;
  targetName: string;
  policy: typeof GATE4E0_POLICY;
  gate4cSnapshotFingerprint: string;
  gate4dOrderedInputFingerprint: string;
  sourceScopeFingerprint: string;
  effectiveSourceIds: string[];
  projectionFingerprint: string;
  validatedAt: Date;
  componentCount: number;
  hypotheticalDrops: number;
  components: Gate4E0ActivationComponent[];
  authority: {
    persistenceOnly: true;
    plannerInfluence: false;
    consumerActivation: false;
    identityWrites: false;
    canonicalWrites: false;
    providerRefReassociation: false;
    preferenceWrites: false;
    sourceCacheWrites: false;
    spotifyPlaylistWrites: false;
    providerCallsInPlannerHotPath: false;
  };
}>;

export type Gate4E0PersistResult = Readonly<{
  projectionId: string;
  version: number;
  status: CanonicalDedupeProjectionStatus;
  projectionFingerprint: string;
  componentCount: number;
  created: boolean;
  revalidated: boolean;
}>;

type Gate4DRunResult = Awaited<
  ReturnType<typeof runMusicIdentityCanonicalRepresentativeSelectionShadow>
>;

export function buildGate4E0ActivationProjection(
  report: Gate4DRunResult,
  targetPlaylistIdInput: string,
): Gate4E0ActivationProjection {
  const targetPlaylistId = clean(targetPlaylistIdInput);
  if (!targetPlaylistId) throw new Error("targetPlaylistId is required");

  if (report.mode !== "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_READ_ONLY") {
    throw new Error(`Gate 4D is not activatable: mode=${report.mode}`);
  }

  assertGate4DAuthority(report);

  const target = report.selection.targets.find(
    (entry) => entry.targetPlaylistId === targetPlaylistId,
  );
  if (!target) throw new Error(`Gate 4D target not found: ${targetPlaylistId}`);
  if (target.selectableCollisions <= 0) {
    throw new Error(`Gate 4D target has no selectable collisions: ${targetPlaylistId}`);
  }
  if (target.abstainedCollisions !== 0) {
    throw new Error(
      `Gate 4D target contains abstained collisions: ${target.abstainedCollisions}`,
    );
  }
  if (target.selectableCollisions !== target.selections.length) {
    throw new Error(
      `Gate 4D selection detail mismatch: selectable=${target.selectableCollisions} detail=${target.selections.length}`,
    );
  }

  const components = target.selections.map(toActivationComponent).sort((a, b) =>
    a.componentId.localeCompare(b.componentId),
  );
  assertUniqueComponents(components);

  const hypotheticalDrops = target.selections.reduce(
    (sum, selection) => sum + selection.hypotheticalDrops,
    0,
  );
  if (hypotheticalDrops !== target.hypotheticalDrops) {
    throw new Error(
      `Gate 4D target drop mismatch: target=${target.hypotheticalDrops} selections=${hypotheticalDrops}`,
    );
  }
  if (target.hypotheticalDrops !== target.gate4cCollisionComponents) {
    throw new Error(
      `Gate 4D target does not reconcile one drop per collision: collisions=${target.gate4cCollisionComponents} drops=${target.hypotheticalDrops}`,
    );
  }

  const effectiveSourceIds = [...new Set(target.effectiveSourceIds)].sort();
  if (!sameStrings(effectiveSourceIds, target.effectiveSourceIds)) {
    throw new Error("Gate 4D effective source order is not canonical/lexicographic");
  }

  const sourceScopeFingerprint = hashJson(effectiveSourceIds);
  const fingerprintBasis = {
    contract: "MUSIC_IDENTITY_GATE4E0_ACTIVATION_PROJECTION_V1",
    userId: report.userId,
    targetPlaylistId: target.targetPlaylistId,
    policy: GATE4E0_POLICY,
    gate4cSnapshotFingerprint: report.baseline.gate4cSnapshotFingerprint,
    gate4dOrderedInputFingerprint: report.baseline.gate4dOrderedInputFingerprint,
    sourceScopeFingerprint,
    effectiveSourceIds,
    components,
  };

  return {
    gate: "4E0",
    mode: "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_READY",
    userId: report.userId,
    targetPlaylistId: target.targetPlaylistId,
    targetName: target.targetName,
    policy: GATE4E0_POLICY,
    gate4cSnapshotFingerprint: report.baseline.gate4cSnapshotFingerprint,
    gate4dOrderedInputFingerprint: report.baseline.gate4dOrderedInputFingerprint,
    sourceScopeFingerprint,
    effectiveSourceIds,
    projectionFingerprint: hashJson(fingerprintBasis),
    validatedAt: report.generatedAt,
    componentCount: components.length,
    hypotheticalDrops,
    components,
    authority: {
      persistenceOnly: true,
      plannerInfluence: false,
      consumerActivation: false,
      identityWrites: false,
      canonicalWrites: false,
      providerRefReassociation: false,
      preferenceWrites: false,
      sourceCacheWrites: false,
      spotifyPlaylistWrites: false,
      providerCallsInPlannerHotPath: false,
    },
  };
}

export async function persistGate4E0ActivationProjection(
  projection: Gate4E0ActivationProjection,
): Promise<Gate4E0PersistResult> {
  if (projection.mode !== "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_READY") {
    throw new Error("projection is not READY");
  }
  if (projection.components.length === 0) {
    throw new Error("projection has no components");
  }

  return prisma.$transaction(
    async (tx) => {
      const target = await tx.targetPlaylist.findFirst({
        where: {
          id: projection.targetPlaylistId,
          userId: projection.userId,
          enabled: true,
        },
        select: {
          id: true,
          name: true,
          sourceScopeMode: true,
          sourceSelections: { select: { sourcePlaylistId: true } },
        },
      });
      if (!target) {
        throw new Error("projection target is missing, disabled, or belongs to another user");
      }

      const sources = await tx.sourcePlaylist.findMany({
        where: { userId: projection.userId },
        select: { id: true, enabled: true },
      });
      const currentScope = resolveTargetSourceScope({
        targetPlaylistId: target.id,
        targetName: target.name,
        sourceScopeMode: target.sourceScopeMode,
        selectedSourceIds: target.sourceSelections.map((row) => row.sourcePlaylistId),
        sources,
      });
      if (!sameStrings(currentScope.effectiveSourceIds, projection.effectiveSourceIds)) {
        throw new Error(
          `target source scope changed before persistence: expected=${projection.effectiveSourceIds.join(",")} current=${currentScope.effectiveSourceIds.join(",")}`,
        );
      }
      if (hashJson(currentScope.effectiveSourceIds) !== projection.sourceScopeFingerprint) {
        throw new Error("target source scope fingerprint changed before persistence");
      }

      const existing = await tx.canonicalDedupeActivationProjection.findFirst({
        where: {
          userId: projection.userId,
          targetPlaylistId: projection.targetPlaylistId,
          policy: projection.policy,
          projectionFingerprint: projection.projectionFingerprint,
        },
        include: { components: true },
      });

      if (existing?.status === CanonicalDedupeProjectionStatus.REVOKED) {
        throw new Error("matching activation projection was explicitly REVOKED");
      }

      if (existing) {
        assertPersistedComponentCount(existing.components.length, projection.componentCount);
        await tx.canonicalDedupeActivationProjection.updateMany({
          where: {
            userId: projection.userId,
            targetPlaylistId: projection.targetPlaylistId,
            policy: projection.policy,
            status: CanonicalDedupeProjectionStatus.READY,
            NOT: { id: existing.id },
          },
          data: { status: CanonicalDedupeProjectionStatus.STALE },
        });
        const refreshed = await tx.canonicalDedupeActivationProjection.update({
          where: { id: existing.id },
          data: {
            status: CanonicalDedupeProjectionStatus.READY,
            validatedAt: projection.validatedAt,
          },
        });
        return {
          projectionId: refreshed.id,
          version: refreshed.version,
          status: refreshed.status,
          projectionFingerprint: refreshed.projectionFingerprint,
          componentCount: projection.componentCount,
          created: false,
          revalidated: true,
        };
      }

      const latest = await tx.canonicalDedupeActivationProjection.findFirst({
        where: {
          userId: projection.userId,
          targetPlaylistId: projection.targetPlaylistId,
          policy: projection.policy,
        },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;

      await tx.canonicalDedupeActivationProjection.updateMany({
        where: {
          userId: projection.userId,
          targetPlaylistId: projection.targetPlaylistId,
          policy: projection.policy,
          status: CanonicalDedupeProjectionStatus.READY,
        },
        data: { status: CanonicalDedupeProjectionStatus.STALE },
      });

      const created = await tx.canonicalDedupeActivationProjection.create({
        data: {
          userId: projection.userId,
          targetPlaylistId: projection.targetPlaylistId,
          version,
          policy: projection.policy,
          status: CanonicalDedupeProjectionStatus.READY,
          gate4cSnapshotFingerprint: projection.gate4cSnapshotFingerprint,
          gate4dOrderedInputFingerprint: projection.gate4dOrderedInputFingerprint,
          sourceScopeFingerprint: projection.sourceScopeFingerprint,
          effectiveSourceIds: projection.effectiveSourceIds as Prisma.InputJsonValue,
          projectionFingerprint: projection.projectionFingerprint,
          validatedAt: projection.validatedAt,
          components: {
            create: projection.components.map((component) => ({
              componentId: component.componentId,
              memberProviderTrackIds:
                component.memberProviderTrackIds as Prisma.InputJsonValue,
              representativeProviderTrackId: component.representativeProviderTrackId,
              preferenceState: component.preferenceState,
              containsExcludedPreference: component.containsExcludedPreference,
            })),
          },
        },
      });

      return {
        projectionId: created.id,
        version: created.version,
        status: created.status,
        projectionFingerprint: created.projectionFingerprint,
        componentCount: projection.componentCount,
        created: true,
        revalidated: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

function assertGate4DAuthority(
  report: MusicIdentityCanonicalRepresentativeSelectionShadowReport,
): void {
  if (report.authority.representativePolicy !== GATE4E0_POLICY) {
    throw new Error(`unsupported representative policy: ${report.authority.representativePolicy}`);
  }
  if (
    report.authority.identityWrites ||
    report.authority.canonicalWrites ||
    report.authority.providerRefReassociation ||
    report.authority.preferenceWrites ||
    report.authority.preferencePropagation ||
    report.authority.sourceCacheWrites ||
    report.authority.consumerActivation ||
    report.authority.plannerInfluence ||
    report.authority.spotifyPlaylistWrites ||
    report.authority.orderHashInfluence ||
    report.authority.productiveRepresentativeSelection
  ) {
    throw new Error("Gate 4D authority is not shadow/read-only");
  }
  if (!report.selection.reductionReconciled) {
    throw new Error("Gate 4D reduction is not reconciled");
  }
  if (!report.orderingProof.postSelectionFingerprintMatched) {
    throw new Error("Gate 4D post-selection fingerprint did not match");
  }
}

function toActivationComponent(selection: Gate4DSelection): Gate4E0ActivationComponent {
  if (selection.policy !== GATE4E0_POLICY) {
    throw new Error(`selection ${selection.componentId} uses unsupported policy`);
  }
  if (selection.containsExcludedPreference) {
    throw new Error(`selection ${selection.componentId} contains EXCLUDED preference`);
  }
  if (selection.decision !== "WOULD_KEEP_DROP") {
    throw new Error(`selection ${selection.componentId} is not WOULD_KEEP_DROP`);
  }

  const members = [...new Set(selection.memberProviderTrackIdsPresent)].sort();
  if (members.length < 2) {
    throw new Error(`selection ${selection.componentId} has fewer than two members`);
  }
  if (!members.includes(selection.representativeProviderTrackId)) {
    throw new Error(`selection ${selection.componentId} representative is not a member`);
  }
  const expectedDropped = members.filter(
    (id) => id !== selection.representativeProviderTrackId,
  );
  const actualDropped = [...new Set(selection.droppedProviderTrackIds)].sort();
  if (!sameStrings(expectedDropped, actualDropped)) {
    throw new Error(`selection ${selection.componentId} dropped-member set is inconsistent`);
  }
  if (selection.hypotheticalDrops !== expectedDropped.length) {
    throw new Error(`selection ${selection.componentId} hypotheticalDrops is inconsistent`);
  }

  return {
    componentId: selection.componentId,
    memberProviderTrackIds: members,
    representativeProviderTrackId: selection.representativeProviderTrackId,
    preferenceState: selection.preferenceState,
    containsExcludedPreference: false,
  };
}

function assertUniqueComponents(components: readonly Gate4E0ActivationComponent[]): void {
  const componentIds = new Set<string>();
  const memberOwners = new Map<string, string>();
  for (const component of components) {
    if (componentIds.has(component.componentId)) {
      throw new Error(`duplicate componentId: ${component.componentId}`);
    }
    componentIds.add(component.componentId);
    for (const providerTrackId of component.memberProviderTrackIds) {
      const owner = memberOwners.get(providerTrackId);
      if (owner && owner !== component.componentId) {
        throw new Error(
          `provider track ${providerTrackId} belongs to multiple activation components`,
        );
      }
      memberOwners.set(providerTrackId, component.componentId);
    }
  }
}

function assertPersistedComponentCount(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(
      `persisted projection component count mismatch: expected=${expected} actual=${actual}`,
    );
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
