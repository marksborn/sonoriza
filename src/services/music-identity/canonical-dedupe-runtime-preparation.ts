import { createHash } from "node:crypto";

import { CanonicalDedupeProjectionStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { firstPartySpotifyTrackSubjectKey } from "@/services/music-preference/first-party-planner-preferences";
import { decodeMusicSourceCache } from "@/services/spotify/source-cache";
import { resolveTargetSourceScope } from "@/services/target-source-scope";

import {
  applyGate4E1ActivationCompatibility,
  createGate4E1RuntimeState,
  GATE4E1_POLICY,
  resolveGate4E1Mode,
  type Gate4E1Component,
  type Gate4E1OrderedOccurrence,
  type Gate4E1RuntimeState,
  type Gate4E1TargetActivation,
} from "./canonical-dedupe-runtime";

/**
 * Gate 4E1 DB-only preparation boundary.
 *
 * This module deliberately imports neither the Gate 4D/4E0 builders nor any
 * provider client. It only validates the already-persisted READY projection
 * against current DB state, then hands immutable data to the pure runtime seam.
 */
export async function prepareGate4E1CanonicalDedupeRuntime(input: {
  userId: string;
  targetPlaylistIds?: readonly string[] | null;
  requestedMode?: string | null;
  allowlist?: string | null;
}): Promise<Gate4E1RuntimeState> {
  const mode = resolveGate4E1Mode({
    requestedMode: input.requestedMode,
    userId: input.userId,
    allowlist: input.allowlist,
    targetPlaylistIds: input.targetPlaylistIds,
  });

  if (mode.effectiveMode === "OFF") {
    return createGate4E1RuntimeState({
      userId: input.userId,
      mode,
      allowlistedTargetIds: mode.allowlistedTargetIds,
      databaseReads: false,
    });
  }

  try {
    const targets = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

        const [targetRows, sourceRows] = await Promise.all([
          tx.targetPlaylist.findMany({
            where: { userId: input.userId, enabled: true },
            orderBy: { id: "asc" },
            select: {
              id: true,
              name: true,
              sourceScopeMode: true,
              sourceSelections: { select: { sourcePlaylistId: true } },
            },
          }),
          tx.sourcePlaylist.findMany({
            where: { userId: input.userId },
            orderBy: { id: "asc" },
            select: {
              id: true,
              kind: true,
              enabled: true,
              cachedCandidates: true,
              cacheUpdatedAt: true,
            },
          }),
        ]);

        const snapshot = buildCurrentGate4DInputSnapshot(targetRows, sourceRows);
        const targetActivation = new Map<string, Gate4E1TargetActivation>();
        for (const target of targetRows) {
          targetActivation.set(
            target.id,
            fallbackTarget(target.id, "NOT_ALLOWLISTED", "user+target pair is not allowlisted"),
          );
        }

        const allowedTargetIds = [...mode.allowlistedTargetIds].filter((targetId) =>
          targetRows.some((target) => target.id === targetId),
        );
        for (const targetId of mode.allowlistedTargetIds) {
          if (!targetRows.some((target) => target.id === targetId)) {
            targetActivation.set(
              targetId,
              fallbackTarget(
                targetId,
                "TARGET_UNAVAILABLE",
                "target is missing, disabled, or belongs to another user",
              ),
            );
          }
        }

        if (allowedTargetIds.length === 0) return targetActivation;

        if (!snapshot.valid) {
          for (const targetId of allowedTargetIds) {
            targetActivation.set(
              targetId,
              fallbackTarget(targetId, "SNAPSHOT_INVALID", snapshot.detail),
            );
          }
          return targetActivation;
        }

        const projections = await tx.canonicalDedupeActivationProjection.findMany({
          where: {
            userId: input.userId,
            targetPlaylistId: { in: allowedTargetIds },
            policy: GATE4E1_POLICY,
            status: CanonicalDedupeProjectionStatus.READY,
          },
          orderBy: [{ targetPlaylistId: "asc" }, { version: "desc" }],
          include: { components: true },
        });
        const projectionByTargetId = new Map<string, typeof projections>();
        for (const projection of projections) {
          const rows = projectionByTargetId.get(projection.targetPlaylistId) ?? [];
          rows.push(projection);
          projectionByTargetId.set(projection.targetPlaylistId, rows);
        }

        const memberTrackIds = new Set<string>();
        for (const projection of projections) {
          for (const component of projection.components) {
            for (const member of jsonStringArray(component.memberProviderTrackIds) ?? []) {
              memberTrackIds.add(member);
            }
          }
        }
        const subjectKeys = [...memberTrackIds].map(firstPartySpotifyTrackSubjectKey);
        const preferences = subjectKeys.length
          ? await tx.firstPartyPlaybackPreference.findMany({
              where: {
                userId: input.userId,
                subjectType: "TRACK",
                subjectKey: { in: subjectKeys },
              },
              select: { subjectKey: true, policy: true, source: true },
            })
          : [];
        const preferenceByKey = new Map(
          preferences.map((preference) => [preference.subjectKey, preference]),
        );

        const currentTargetById = new Map(snapshot.targets.map((target) => [target.id, target]));
        for (const targetId of allowedTargetIds) {
          const ready = projectionByTargetId.get(targetId) ?? [];
          if (ready.length === 0) {
            targetActivation.set(
              targetId,
              fallbackTarget(
                targetId,
                "PROJECTION_NOT_READY",
                "no READY projection exists for the supported policy",
              ),
            );
            continue;
          }
          if (ready.length !== 1) {
            targetActivation.set(
              targetId,
              fallbackTarget(
                targetId,
                "MULTIPLE_READY_PROJECTIONS",
                `expected one READY projection, found ${ready.length}`,
              ),
            );
            continue;
          }

          const projection = ready[0]!;
          const currentTarget = currentTargetById.get(targetId);
          const persistedSourceIds = jsonStringArray(projection.effectiveSourceIds);
          if (
            !currentTarget ||
            !persistedSourceIds ||
            !sameStrings(currentTarget.effectiveSourceIds, persistedSourceIds) ||
            hashJson(currentTarget.effectiveSourceIds) !== projection.sourceScopeFingerprint
          ) {
            targetActivation.set(
              targetId,
              fallbackTarget(
                targetId,
                "SOURCE_SCOPE_MISMATCH",
                "effective target source scope differs from the READY projection",
              ),
            );
            continue;
          }

          const validatedComponents = validateComponents(
            projection.components,
            preferenceByKey,
          );
          if (!validatedComponents) {
            targetActivation.set(
              targetId,
              fallbackTarget(
                targetId,
                "PROJECTION_INVALID",
                "READY projection component contract is invalid",
              ),
            );
            continue;
          }

          const components = applyGate4E1ActivationCompatibility({
            components: validatedComponents,
            occurrences: buildTargetOccurrences(currentTarget, snapshot.sources),
          });

          targetActivation.set(targetId, {
            targetPlaylistId: targetId,
            status: "READY",
            reason: null,
            projectionId: projection.id,
            projectionVersion: projection.version,
            projectionFingerprint: projection.projectionFingerprint,
            components,
          });
        }

        return targetActivation;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return createGate4E1RuntimeState({
      userId: input.userId,
      mode,
      allowlistedTargetIds: mode.allowlistedTargetIds,
      targets,
      databaseReads: true,
    });
  } catch {
    return createGate4E1RuntimeState({
      userId: input.userId,
      mode,
      allowlistedTargetIds: mode.allowlistedTargetIds,
      databaseReads: true,
      activationReason: "PREPARATION_ERROR",
    });
  }
}

type TargetRow = Readonly<{
  id: string;
  name: string;
  sourceScopeMode: "INHERIT_GLOBAL" | "SELECTED_ONLY";
  sourceSelections: readonly { sourcePlaylistId: string }[];
}>;

type SourceRow = Readonly<{
  id: string;
  kind: "MUSIC" | "PODCAST";
  enabled: boolean;
  cachedCandidates: unknown;
  cacheUpdatedAt: Date | null;
}>;

type CurrentTarget = Readonly<{
  id: string;
  name: string;
  effectiveSourceIds: string[];
}>;

type CurrentSource = Readonly<{
  id: string;
  cacheUpdatedAt: Date;
  candidates: Array<{ cachePosition: number; providerTrackId: string; uri: string }>;
}>;

type SnapshotResult =
  | Readonly<{
      valid: true;
      detail: null;
      targets: CurrentTarget[];
      sources: CurrentSource[];
      fingerprint: string;
    }>
  | Readonly<{
      valid: false;
      detail: string;
      targets: CurrentTarget[];
      sources: [];
      fingerprint: "";
    }>;

function buildCurrentGate4DInputSnapshot(
  targets: readonly TargetRow[],
  sources: readonly SourceRow[],
): SnapshotResult {
  const scopeSources = sources.map((source) => ({ id: source.id, enabled: source.enabled }));
  const orderedTargets: CurrentTarget[] = [];
  const reachableSourceIds = new Set<string>();

  for (const target of targets) {
    const scope = resolveTargetSourceScope({
      targetPlaylistId: target.id,
      targetName: target.name,
      sourceScopeMode: target.sourceScopeMode,
      selectedSourceIds: target.sourceSelections.map((row) => row.sourcePlaylistId),
      sources: scopeSources,
    });
    const effectiveSourceIds = scope.effectiveSourceIds
      .filter((sourceId) =>
        sources.some((source) => source.id === sourceId && source.kind === "MUSIC"),
      )
      .sort();
    for (const sourceId of effectiveSourceIds) reachableSourceIds.add(sourceId);
    orderedTargets.push({ id: target.id, name: target.name, effectiveSourceIds });
  }
  orderedTargets.sort((a, b) => a.id.localeCompare(b.id));

  const orderedSources: CurrentSource[] = [];
  for (const source of sources
    .filter((row) => row.kind === "MUSIC" && reachableSourceIds.has(row.id))
    .sort((a, b) => a.id.localeCompare(b.id))) {
    if (!source.cacheUpdatedAt) {
      return {
        valid: false,
        detail: `source ${source.id} has no cacheUpdatedAt`,
        targets: orderedTargets,
        sources: [],
        fingerprint: "",
      };
    }
    const decoded = decodeMusicSourceCache(source.cachedCandidates);
    if (!decoded) {
      return {
        valid: false,
        detail: `source ${source.id} is not FULL_VALID`,
        targets: orderedTargets,
        sources: [],
        fingerprint: "",
      };
    }
    orderedSources.push({
      id: source.id,
      cacheUpdatedAt: source.cacheUpdatedAt,
      candidates: decoded.flatMap((candidate, cachePosition) => {
        const providerTrackId = clean(candidate.spotifyTrackId);
        return providerTrackId
          ? [{ cachePosition, providerTrackId, uri: candidate.uri }]
          : [];
      }),
    });
  }

  // Keep the exact Gate 4D-style snapshot fingerprint for diagnostics, but do
  // not use equality of this global value as an activation gate. In particular,
  // cacheUpdatedAt renewal alone must not invalidate otherwise-compatible
  // target/component projections.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        targets: orderedTargets.map((target) => ({
          id: target.id,
          name: target.name,
          effectiveSourceIds: target.effectiveSourceIds,
        })),
        sources: orderedSources.map((source) => ({
          id: source.id,
          cacheUpdatedAt: source.cacheUpdatedAt.toISOString(),
          candidates: source.candidates.map((candidate) => [
            candidate.cachePosition,
            candidate.providerTrackId,
            candidate.uri,
          ]),
        })),
      }),
    )
    .digest("hex");

  return {
    valid: true,
    detail: null,
    targets: orderedTargets,
    sources: orderedSources,
    fingerprint,
  };
}

function buildTargetOccurrences(
  target: CurrentTarget,
  sources: readonly CurrentSource[],
): Gate4E1OrderedOccurrence[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return target.effectiveSourceIds.flatMap((sourceId, sourceOrder) => {
    const source = sourceById.get(sourceId);
    return (source?.candidates ?? []).map((candidate) => ({
      sourcePlaylistId: sourceId,
      sourceOrder,
      cachePosition: candidate.cachePosition,
      providerTrackId: candidate.providerTrackId,
    }));
  });
}

function validateComponents(
  rows: readonly {
    componentId: string;
    memberProviderTrackIds: Prisma.JsonValue;
    representativeProviderTrackId: string;
    preferenceState: string;
    containsExcludedPreference: boolean;
  }[],
  preferenceByKey: ReadonlyMap<
    string,
    { subjectKey: string; policy: string; source: string }
  >,
): Gate4E1Component[] | null {
  if (rows.length === 0) return null;
  const componentIds = new Set<string>();
  const memberOwner = new Map<string, string>();
  const result: Gate4E1Component[] = [];

  for (const row of rows) {
    if (componentIds.has(row.componentId)) return null;
    componentIds.add(row.componentId);
    const members = jsonStringArray(row.memberProviderTrackIds);
    if (!members || members.length < 2) return null;
    const uniqueMembers = [...new Set(members)].sort();
    if (uniqueMembers.length !== members.length) return null;
    if (!uniqueMembers.includes(row.representativeProviderTrackId)) return null;

    for (const member of uniqueMembers) {
      const owner = memberOwner.get(member);
      if (owner && owner !== row.componentId) return null;
      memberOwner.set(member, row.componentId);
    }

    const currentPreferences = uniqueMembers.map(
      (member) => preferenceByKey.get(firstPartySpotifyTrackSubjectKey(member)) ?? null,
    );
    const currentPreferenceState = classifyPreferenceState(currentPreferences);
    const currentContainsExcluded = currentPreferences.some(
      (preference) => preference?.policy === "EXCLUDED",
    );

    result.push({
      componentId: row.componentId,
      memberProviderTrackIds: uniqueMembers,
      representativeProviderTrackId: row.representativeProviderTrackId,
      preferenceState: row.preferenceState,
      preferenceCompatible:
        row.preferenceState === currentPreferenceState && !currentContainsExcluded,
      containsExcludedPreference:
        row.containsExcludedPreference || currentContainsExcluded,
    });
  }

  return result.sort((a, b) => a.componentId.localeCompare(b.componentId));
}

function classifyPreferenceState(
  preferences: readonly ({ policy: string; source: string } | null)[],
): string {
  const present = preferences.filter(
    (preference): preference is { policy: string; source: string } => preference !== null,
  );
  if (present.length === 0) return "NO_EXPLICIT_TRACK_PREFERENCE";
  if (present.length !== preferences.length) return "PREFERENCE_PRESENCE_DIVERGENCE";
  if (new Set(present.map((preference) => preference.policy)).size !== 1) {
    return "PREFERENCE_POLICY_DIVERGENCE";
  }
  if (new Set(present.map((preference) => preference.source)).size !== 1) {
    return "PREFERENCE_SOURCE_DIVERGENCE";
  }
  return "IDENTICAL_EXPLICIT_TRACK_PREFERENCE";
}

function fallbackTarget(
  targetPlaylistId: string,
  status: Gate4E1TargetActivation["status"],
  reason: string,
): Gate4E1TargetActivation {
  return {
    targetPlaylistId,
    status,
    reason,
    projectionId: null,
    projectionVersion: null,
    projectionFingerprint: null,
    components: [],
  };
}

function jsonStringArray(value: Prisma.JsonValue): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const normalized = clean(entry);
    if (!normalized) return null;
    result.push(normalized);
  }
  return result;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
