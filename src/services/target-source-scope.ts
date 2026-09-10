export type TargetSourceScopeModeValue =
  | "INHERIT_GLOBAL"
  | "SELECTED_ONLY";

export type TargetSourceScopeSource = {
  id: string;
  enabled: boolean;
};

export type TargetSourceScopeInput = {
  targetPlaylistId: string;
  targetName: string;
  sourceScopeMode: TargetSourceScopeModeValue;
  selectedSourceIds: Iterable<string>;
  sources: readonly TargetSourceScopeSource[];
};

export type TargetSourceScopeResolution = {
  targetPlaylistId: string;
  targetName: string;
  sourceScopeMode: TargetSourceScopeModeValue;
  selectedSourceIds: string[];
  globallyEnabledSourceIds: string[];
  effectiveSourceIds: string[];
  ignoredDisabledSourceIds: string[];
  plannerInfluence: false;
};

/**
 * TARGET-SCOPE-01 Gate 2.
 *
 * Resolves the source contract only. It deliberately has no planner/runtime
 * side effects; productive activation belongs to Gate 3.
 */
export function resolveTargetSourceScope(
  input: TargetSourceScopeInput,
): TargetSourceScopeResolution {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));

  const globallyEnabledSourceIds = input.sources
    .filter((source) => source.enabled)
    .map((source) => source.id)
    .sort();

  const selectedSourceIds = [...new Set(input.selectedSourceIds)].sort();

  const ignoredDisabledSourceIds = selectedSourceIds
    .filter((sourceId) => sourceById.get(sourceId)?.enabled === false)
    .sort();

  const enabledSet = new Set(globallyEnabledSourceIds);

  const effectiveSourceIds =
    input.sourceScopeMode === "SELECTED_ONLY"
      ? selectedSourceIds.filter((sourceId) => enabledSet.has(sourceId))
      : globallyEnabledSourceIds;

  return {
    targetPlaylistId: input.targetPlaylistId,
    targetName: input.targetName,
    sourceScopeMode: input.sourceScopeMode,
    selectedSourceIds,
    globallyEnabledSourceIds,
    effectiveSourceIds,
    ignoredDisabledSourceIds,
    plannerInfluence: false,
  };
}

export type TargetSourceScopeShadowResolution =
  TargetSourceScopeResolution & {
    unavailableEffectiveSourceIds: string[];
  };

export function attachUnavailableTargetSources(
  resolution: TargetSourceScopeResolution,
  unavailableSourceIds: ReadonlySet<string>,
): TargetSourceScopeShadowResolution {
  return {
    ...resolution,
    unavailableEffectiveSourceIds: resolution.effectiveSourceIds.filter(
      (sourceId) => unavailableSourceIds.has(sourceId),
    ),
  };
}
