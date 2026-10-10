import { createHash } from "node:crypto";

import {
  DEFAULT_PODCAST_DURATION_BAND_LIMITS,
  parsePodcastDurationBandLimits,
  type PodcastDurationBand,
  type PodcastDurationBandLimits,
} from "./podcast-duration-bands";

/**
 * PODCAST-08 Gate 3: sidecar metadata for persisted legacy ContentType[].
 *
 * sequencePattern remains ["MUSIC","PODCAST",...]. Slot bands align 1:1 with
 * those positions; MUSIC must be ANY and missing sidecar means all ANY.
 * Do not wire selection to this module until the separate shadow/active gates.
 */
export type PersistedPodcastDurationSlots = readonly PodcastDurationBand[];

export function parsePersistedPodcastDurationSlots(
  sequencePattern: unknown,
  rawBands: unknown,
): PersistedPodcastDurationSlots | null {
  if (
    !Array.isArray(sequencePattern) ||
    sequencePattern.length < 1 ||
    sequencePattern.length > 20 ||
    !sequencePattern.every((type) => type === "MUSIC" || type === "PODCAST")
  ) {
    return null;
  }
  if (rawBands === null || rawBands === undefined) {
    return sequencePattern.map(() => "ANY");
  }
  if (!Array.isArray(rawBands) || rawBands.length !== sequencePattern.length) {
    return null;
  }
  const bands: PodcastDurationBand[] = [];
  for (let index = 0; index < sequencePattern.length; index++) {
    const band = rawBands[index];
    if (
      band !== "ANY" &&
      band !== "SHORT" &&
      band !== "MEDIUM" &&
      band !== "LONG"
    ) {
      return null;
    }
    if (sequencePattern[index] === "MUSIC" && band !== "ANY") return null;
    bands.push(band);
  }
  return bands;
}

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
