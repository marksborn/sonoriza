import { createHash } from "node:crypto";
import { parsePersistedPodcastDurationSlots } from "./podcast-duration-sequence-sidecar";
export { parsePersistedPodcastDurationSlots, type PersistedPodcastDurationSlots } from "./podcast-duration-sequence-sidecar";

import {
  DEFAULT_PODCAST_DURATION_BAND_LIMITS,
  parsePodcastDurationBandLimits,
  type PodcastDurationBandLimits,
} from "./podcast-duration-bands";

/**
 * PODCAST-08 Gate 3: sidecar metadata for persisted legacy ContentType[].
 *
 * sequencePattern remains ["MUSIC","PODCAST",...]. Slot bands align 1:1 with
 * those positions; MUSIC must be ANY and missing sidecar means all ANY.
 * Do not wire selection to this module until the separate shadow/active gates.
 */
export type PodcastDurationFingerprintTarget = Readonly<{
  id: string;
  compositionMode: "PROPORTION" | "SEQUENCE";
  sequencePattern: unknown;
  podcastDurationSlotBands: unknown;
}>;

/**
 * Decorator of CONFIG-04's existing fingerprint. Exactly neutral for legacy
 * sequences and when all enabled slots remain ANY, regardless of whether a
 * user settings row exists. Only scoped targets with a specific band matter.
 *
 * Invalid stored sidecars/limits must be reported as configuration issues by
 * the caller BEFORE this function is used to authorize any productive run.
 */
export function podcastDurationConfigurationFingerprint(
  baseFingerprint: string,
  targets: readonly PodcastDurationFingerprintTarget[],
  limits: PodcastDurationBandLimits = DEFAULT_PODCAST_DURATION_BAND_LIMITS,
): string {
  const active = targets
    .filter((target) => target.compositionMode === "SEQUENCE")
    .map((target) => {
      const bands = parsePersistedPodcastDurationSlots(
        target.sequencePattern,
        target.podcastDurationSlotBands,
      );
      if (bands === null) {
        throw new Error("Invalid PODCAST-08 duration sequence sidecar");
      }
      return { id: target.id, bands };
    })
    .filter((target) => target.bands.some((band) => band !== "ANY"))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (active.length === 0) return baseFingerprint;

  const validatedLimits = parsePodcastDurationBandLimits(limits);
  if (!validatedLimits) {
    throw new Error("Invalid PODCAST-08 global duration band limits");
  }

  return createHash("sha256")
    .update(JSON.stringify({
      baseFingerprint,
      podcast08: {
        version: 1,
        limits: validatedLimits,
        targets: active,
        fallback: "SHORT>MEDIUM>ANY|MEDIUM>SHORT>LONG>ANY|LONG>MEDIUM>ANY",
      },
    }))
    .digest("hex");
}
