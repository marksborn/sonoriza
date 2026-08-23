import {
  normalizeTargetDiscoveryPolicy,
  serializeTargetDiscoveryPolicy,
  type TargetDiscoveryIntensity,
  type TargetDiscoveryPolicyPersistence,
} from "./target-discovery-policy";

export type TargetDiscoveryFormFields = {
  discoveryEnabled: string | null;
  discoveryFamiliarEnabled: string | null;
  discoveryRediscoveryEnabled: string | null;
  discoveryNoveltyEnabled: string | null;
  discoveryReleasesEnabled: string | null;
  discoveryIntensity: string | null;
};

const VALID_INTENSITIES = new Set<TargetDiscoveryIntensity>([
  "CONSERVATIVE",
  "BALANCED",
  "EXPLORATORY",
]);

export function targetDiscoveryPolicyFromForm(
  fields: TargetDiscoveryFormFields,
): TargetDiscoveryPolicyPersistence {
  if (!VALID_INTENSITIES.has(fields.discoveryIntensity as TargetDiscoveryIntensity)) {
    throw new Error("invalid-target-discovery-intensity");
  }

  return serializeTargetDiscoveryPolicy(
    normalizeTargetDiscoveryPolicy({
      discoveryEnabled: fields.discoveryEnabled === "on",
      discoveryFamiliarEnabled: fields.discoveryFamiliarEnabled === "on",
      discoveryRediscoveryEnabled: fields.discoveryRediscoveryEnabled === "on",
      discoveryNoveltyEnabled: fields.discoveryNoveltyEnabled === "on",
      discoveryReleasesEnabled: fields.discoveryReleasesEnabled === "on",
      discoveryIntensity: fields.discoveryIntensity,
    }),
  );
}
