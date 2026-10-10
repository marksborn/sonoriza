import type { PodcastDurationBand } from "./podcast-duration-bands";

/** Browser-safe PODCAST-08 parser; never import node:crypto or Prisma here. */
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
      band !== "ANY" && band !== "SHORT" &&
      band !== "MEDIUM" && band !== "LONG"
    ) {
      return null;
    }
    if (sequencePattern[index] === "MUSIC" && band !== "ANY") return null;
    bands.push(band);
  }
  return bands;
}
