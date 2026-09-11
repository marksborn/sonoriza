import {
  normalizeTargetDiscoveryPolicy,
  serializeTargetDiscoveryPolicy,
  type TargetDiscoveryPolicyPersistence,
} from "@/services/music-discovery/target-discovery-policy";

export type OnboardingDiscoveryPreset =
  | "FAMILIAR"
  | "BALANCED"
  | "EXPLORATORY";

export function onboardingDiscoveryPresetData(
  preset: OnboardingDiscoveryPreset,
): TargetDiscoveryPolicyPersistence {
  switch (preset) {
    case "FAMILIAR":
      return serializeTargetDiscoveryPolicy(
        normalizeTargetDiscoveryPolicy({
          discoveryEnabled: true,
          discoveryFamiliarEnabled: true,
          discoveryRediscoveryEnabled: true,
          discoveryNoveltyEnabled: false,
          discoveryReleasesEnabled: false,
          discoveryIntensity: "CONSERVATIVE",
        }),
      );

    case "BALANCED":
      return serializeTargetDiscoveryPolicy(
        normalizeTargetDiscoveryPolicy({
          discoveryEnabled: true,
          discoveryFamiliarEnabled: true,
          discoveryRediscoveryEnabled: true,
          discoveryNoveltyEnabled: true,
          discoveryReleasesEnabled: true,
          discoveryIntensity: "BALANCED",
        }),
      );

    case "EXPLORATORY":
      return serializeTargetDiscoveryPolicy(
        normalizeTargetDiscoveryPolicy({
          discoveryEnabled: true,
          discoveryFamiliarEnabled: true,
          discoveryRediscoveryEnabled: true,
          discoveryNoveltyEnabled: true,
          discoveryReleasesEnabled: true,
          discoveryIntensity: "EXPLORATORY",
        }),
      );
  }
}
