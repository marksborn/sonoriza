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
