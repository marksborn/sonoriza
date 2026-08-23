import {
  normalizeTargetDiscoveryPolicy,
  type PersistedTargetDiscoveryPolicy,
  type TargetDiscoveryIntensity,
  type TargetDiscoveryPolicy,
} from "./target-discovery-policy";

export const TARGET_DISCOVERY_RUNTIME_GATE5_POLICY = {
  version: "discover-dest-gate5-runtime-v1",
  mode: "CONTROLLED_RUNTIME",
  activationRule:
    "BASE_DISCOVERY_AND_TARGET_RUNTIME_FLAG_AND_USER_ALLOWLIST_AND_TARGET_MASTER",
  sourceRule: "PER_TARGET_MUSIC_ORDER_WITH_NORMAL_SOURCE_FALLBACK",
  externalRule: "PER_TARGET_DISCOVERY_FAMILY_ONLY",
  releaseRule: "ABSTAIN_WHILE_PROVIDER_UNAVAILABLE",
  intensityRule: "BOUNDED_INTERNAL_CAP_NO_FORCE_FILL",
  albums: "EXCLUDED",
  caps: {
    CONSERVATIVE: { rediscoveryCeiling: 0.15, externalDiscoveryCeiling: 0.1 },
    BALANCED: { rediscoveryCeiling: 0.25, externalDiscoveryCeiling: 0.2 },
    // Exploratory may use the full ceilings already validated by DISCOVERY-01.
    // It intentionally does not relax those safety bounds in this rollout gate.
    EXPLORATORY: { rediscoveryCeiling: 0.25, externalDiscoveryCeiling: 0.2 },
  },
} as const;

export type TargetDiscoveryRuntimePolicyReason =
  | "BASE_DISCOVERY_DISABLED"
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "ENABLED";

export type TargetDiscoveryRuntimeCaps = {
  rediscoveryCeiling: number;
  externalDiscoveryCeiling: number;
};

export type TargetDiscoveryRuntimeTarget = {
  targetPlaylistId: string;
  targetName?: string | null;
  persistedPolicy: PersistedTargetDiscoveryPolicy | null | undefined;
};

export function resolveTargetDiscoveryRuntimePolicy(input: {
  baseDiscoveryEnabled: boolean;
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
}): { enabled: boolean; reason: TargetDiscoveryRuntimePolicyReason } {
  if (!input.baseDiscoveryEnabled) {
    return { enabled: false, reason: "BASE_DISCOVERY_DISABLED" };
  }
  if (!parseBoolean(input.masterEnabled)) {
    return { enabled: false, reason: "MASTER_DISABLED" };
  }

  const email = normalizeEmail(input.userEmail);
  if (!email) return { enabled: false, reason: "USER_EMAIL_MISSING" };

  const allowlist = new Set(
    String(input.allowlistedEmails ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value): value is string => Boolean(value)),
  );
  if (!allowlist.has(email)) {
    return { enabled: false, reason: "USER_NOT_ALLOWLISTED" };
  }
  return { enabled: true, reason: "ENABLED" };
}

export function targetDiscoveryRuntimeCaps(
  intensity: TargetDiscoveryIntensity,
): TargetDiscoveryRuntimeCaps {
  return { ...TARGET_DISCOVERY_RUNTIME_GATE5_POLICY.caps[intensity] };
}

export function normalizeTargetDiscoveryRuntimeTargets(
  targets: TargetDiscoveryRuntimeTarget[],
): Map<string, TargetDiscoveryPolicy> {
  return new Map(
    targets.map((target) => [
      target.targetPlaylistId,
      normalizeTargetDiscoveryPolicy(target.persistedPolicy),
    ]),
  );
}

export function targetUsesSourceDiscovery(policy: TargetDiscoveryPolicy): boolean {
  return Boolean(
    policy.enabled && (policy.familiarEnabled || policy.rediscoveryEnabled),
  );
}

export function targetUsesExternalDiscovery(policy: TargetDiscoveryPolicy): boolean {
  return Boolean(policy.enabled && policy.discoveryEnabled);
}

export function targetDiscoveryPolicyFingerprint(
  policy: TargetDiscoveryPolicy,
): string {
  return [
    policy.enabled ? "1" : "0",
    policy.familiarEnabled ? "1" : "0",
    policy.rediscoveryEnabled ? "1" : "0",
    policy.discoveryEnabled ? "1" : "0",
    policy.releasesEnabled ? "1" : "0",
    policy.intensity,
  ].join(":");
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function parseBoolean(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}
