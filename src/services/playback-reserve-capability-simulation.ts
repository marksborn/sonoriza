/**
 * FEATURE-PARITY-B1 (#460): opt-in simulation by existing product policy.
 *
 * This helper only authorizes the planner to evaluate a SINGLE destination
 * during an explicitly requested SIMULATION. It can NEVER authorize a real
 * Spotify write, which remains subject to the legacy target allowlist and
 * Gate 8 approval/snapshot protections.
 *
 * Default OFF until the capability-based simulation pilot is approved.
 */
export function canSimulatePlaybackReserveByCapability(input: Readonly<{
  simulate: boolean;
  selectedTargetCount: number;
  targetEnabled: boolean;
  targetLinkedToSpotify: boolean;
  updatePolicy: string;
  reserveMode: "NONE" | "DURATION" | "MUSIC_TRACKS" | "PODCAST_EPISODES";
  globalRuntimeMode: string;
  capabilitySimulationMode: string | undefined;
}>): boolean {
  return (
    input.simulate === true &&
    input.selectedTargetCount === 1 &&
    input.targetEnabled === true &&
    input.targetLinkedToSpotify === true &&
    (input.updatePolicy === "KEEP_FILLED" ||
      input.updatePolicy === "REBUILD_DAILY") &&
    input.reserveMode !== "NONE" &&
    input.globalRuntimeMode === "ACTIVE" &&
    input.capabilitySimulationMode?.trim().toUpperCase() === "ACTIVE"
  );
}
