import type { ContentType } from "./types";
import type { PodcastDurationBand } from "./podcast-duration-bands";
import { parsePersistedPodcastDurationSlots } from "./podcast-duration-persistence";

export type PodcastDurationEditorSlot = Readonly<{
  type: ContentType;
  band: PodcastDurationBand;
}>;

/** Keep type + requested band in the same object during all UI operations. */
export function hydratePodcastDurationEditorSlots(
  sequence: readonly ContentType[],
  storedBands: unknown,
): PodcastDurationEditorSlot[] | null {
  const bands = parsePersistedPodcastDurationSlots(sequence, storedBands);
  if (!bands) return null;
  return sequence.map((type, index) => ({ type, band: bands[index]! }));
}

export function appendPodcastDurationEditorSlot(
  slots: readonly PodcastDurationEditorSlot[],
  type: ContentType,
): PodcastDurationEditorSlot[] {
  if (slots.length >= 20) return [...slots];
  return [...slots, { type, band: "ANY" }];
}

export function movePodcastDurationEditorSlot(
  slots: readonly PodcastDurationEditorSlot[],
  index: number,
  direction: -1 | 1,
): PodcastDurationEditorSlot[] {
  const to = index + direction;
  if (index < 0 || to < 0 || to >= slots.length) return [...slots];
  const next = [...slots];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export function removePodcastDurationEditorSlot(
  slots: readonly PodcastDurationEditorSlot[],
  index: number,
): PodcastDurationEditorSlot[] {
  if (slots.length <= 1 || index < 0 || index >= slots.length) return [...slots];
  return slots.filter((_, at) => at !== index);
}

export function setPodcastDurationEditorBand(
  slots: readonly PodcastDurationEditorSlot[],
  index: number,
  band: PodcastDurationBand,
): PodcastDurationEditorSlot[] {
  if (index < 0 || index >= slots.length || slots[index]?.type !== "PODCAST") {
    return [...slots];
  }
  return slots.map((slot, at) => at === index ? { ...slot, band } : slot);
}

/** JSON sent by the form must contain BOTH arrays from one state snapshot. */
export function serializePodcastDurationEditorSlots(slots: readonly PodcastDurationEditorSlot[]) {
  return {
    sequencePattern: JSON.stringify(slots.map(({ type }) => type)),
    podcastDurationSlotBands: JSON.stringify(slots.map(({ band }) => band)),
  };
}

/**
 * Feature-gated write guard. With the editor OFF, legacy ANY sequences can
 * still be edited freely. Existing pilot-specific bands can only be preserved
 * unchanged (including position); malicious/stale clients cannot activate one.
 */
export function maySavePodcastDurationBandsWhenEditorDisabled(input: {
  existingSequence: unknown | null;
  existingBands: unknown;
  nextSequence: readonly ContentType[];
  nextBands: readonly PodcastDurationBand[];
}): boolean {
  const next = parsePersistedPodcastDurationSlots(input.nextSequence, input.nextBands);
  if (!next) return false;
  if (input.existingSequence === null) return next.every((band) => band === "ANY");
  const existing = parsePersistedPodcastDurationSlots(
    input.existingSequence, input.existingBands,
  );
  if (!existing) return false;
  const active = existing.some((band) => band !== "ANY");
  if (!active) return next.every((band) => band === "ANY");
  return (
    JSON.stringify(input.existingSequence) === JSON.stringify(input.nextSequence) &&
    JSON.stringify(existing) === JSON.stringify(next)
  );
}
