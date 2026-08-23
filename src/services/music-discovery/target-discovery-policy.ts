export const TARGET_DISCOVERY_POLICY_VERSION = "discover-dest-policy-v1" as const;

export type TargetDiscoveryIntensity =
  | "CONSERVATIVE"
  | "BALANCED"
  | "EXPLORATORY";

export type TargetDiscoveryFamily =
  | "FAMILIAR"
  | "REDISCOVERY"
  | "DISCOVERY"
  | "RELEASE";

export type TargetDiscoveryPolicy = {
  version: typeof TARGET_DISCOVERY_POLICY_VERSION;
  enabled: boolean;
  familiarEnabled: boolean;
  rediscoveryEnabled: boolean;
  discoveryEnabled: boolean;
  releasesEnabled: boolean;
  intensity: TargetDiscoveryIntensity;
};

export type PersistedTargetDiscoveryPolicy = {
  discoveryEnabled?: boolean | null;
  discoveryFamiliarEnabled?: boolean | null;
  discoveryRediscoveryEnabled?: boolean | null;
  discoveryNoveltyEnabled?: boolean | null;
  discoveryReleasesEnabled?: boolean | null;
  discoveryIntensity?: string | null;
};

export const DEFAULT_TARGET_DISCOVERY_POLICY: TargetDiscoveryPolicy = {
  version: TARGET_DISCOVERY_POLICY_VERSION,
  enabled: false,
  familiarEnabled: true,
  rediscoveryEnabled: true,
  discoveryEnabled: true,
  releasesEnabled: true,
  intensity: "BALANCED",
};

export const TARGET_DISCOVERY_POLICY_SEMANTICS = {
  scope: "PER_TARGET_PLAYLIST",
  composition: "ENRICHMENT_NOT_REQUIRED_QUOTA",
  albums: "EXCLUDED_FROM_TRACK_CANDIDATE_FAMILIES",
  currentSources: "PRESERVED_WHEN_DISCOVERY_DISABLED",
  weakCandidateBehavior: "DO_NOT_FORCE_DISCOVERY_FILL",
} as const;

export function normalizeTargetDiscoveryPolicy(
  persisted: PersistedTargetDiscoveryPolicy | null | undefined,
): TargetDiscoveryPolicy {
  if (!persisted) return { ...DEFAULT_TARGET_DISCOVERY_POLICY };

  return {
    version: TARGET_DISCOVERY_POLICY_VERSION,
    enabled: persisted.discoveryEnabled === true,
    familiarEnabled: persisted.discoveryFamiliarEnabled !== false,
    rediscoveryEnabled: persisted.discoveryRediscoveryEnabled !== false,
    discoveryEnabled: persisted.discoveryNoveltyEnabled !== false,
    releasesEnabled: persisted.discoveryReleasesEnabled !== false,
    intensity: normalizeIntensity(persisted.discoveryIntensity),
  };
}

export function allowedTargetDiscoveryFamilies(
  policy: TargetDiscoveryPolicy,
): TargetDiscoveryFamily[] {
  if (!policy.enabled) return [];

  const families: TargetDiscoveryFamily[] = [];
  if (policy.familiarEnabled) families.push("FAMILIAR");
  if (policy.rediscoveryEnabled) families.push("REDISCOVERY");
  if (policy.discoveryEnabled) families.push("DISCOVERY");
  if (policy.releasesEnabled) families.push("RELEASE");
  return families;
}

export function targetAllowsDiscoveryFamily(
  policy: TargetDiscoveryPolicy,
  family: TargetDiscoveryFamily,
): boolean {
  return allowedTargetDiscoveryFamilies(policy).includes(family);
}

export function discoveryIntensityRank(
  intensity: TargetDiscoveryIntensity,
): 1 | 2 | 3 {
  switch (intensity) {
    case "CONSERVATIVE":
      return 1;
    case "BALANCED":
      return 2;
    case "EXPLORATORY":
      return 3;
  }
}

function normalizeIntensity(value: string | null | undefined): TargetDiscoveryIntensity {
  switch (value) {
    case "CONSERVATIVE":
    case "BALANCED":
    case "EXPLORATORY":
      return value;
    default:
      return "BALANCED";
  }
}
