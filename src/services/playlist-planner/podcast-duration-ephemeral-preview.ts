import type { ContentType } from "./types";
import type { PodcastDurationBand } from "./podcast-duration-bands";
import { parsePersistedPodcastDurationSlots } from "./podcast-duration-sequence-sidecar";

export type Podcast08EphemeralPreview = Readonly<{
  targetPlaylistId: string;
  bands: readonly PodcastDurationBand[];
}>;

/**
 * #449 — a preview is a one-time SIMULATION scope, never a persisted setting
 * or approval for productive Spotify operations.
 */
export function validatePodcast08EphemeralPreviewRequest(input: {
  simulate: boolean;
  targetScope: readonly string[] | null;
  preview: Podcast08EphemeralPreview;
  activeMode: string | undefined;
}): void {
  const p = input.preview;
  if (
    !input.simulate ||
    !p.targetPlaylistId ||
    !input.targetScope ||
    input.targetScope.length !== 1 ||
    input.targetScope[0] !== p.targetPlaylistId ||
    input.activeMode === "ACTIVE" ||
    !Array.isArray(p.bands) ||
    p.bands.length === 0 ||
    p.bands.length > 20 ||
    !p.bands.some(band => band !== "ANY") ||
    !p.bands.every(band => ["ANY","SHORT","MEDIUM","LONG"].includes(band))
  ) {
    throw new Error(
      "PODCAST-08 preview requires one explicitly scoped simulation with valid non-ANY bands and ACTIVE mode OFF.",
    );
  }
}

export function validatePodcast08EphemeralPreviewTarget(input: {
  preview: Podcast08EphemeralPreview;
  targetId: string;
  compositionMode: "PROPORTION" | "SEQUENCE";
  sequencePattern: readonly ContentType[];
  hasDurationBlocks: boolean;
  enabled: boolean;
}): void {
  if (
    !input.enabled ||
    input.targetId !== input.preview.targetPlaylistId ||
    input.compositionMode !== "SEQUENCE" ||
    input.hasDurationBlocks ||
    !parsePersistedPodcastDurationSlots(
      input.sequencePattern, input.preview.bands,
    ) ||
    !input.preview.bands.some(band => band !== "ANY")
  ) {
    throw new Error(
      "PODCAST-08 preview target must be an enabled single-block SEQUENCE target with aligned bands.",
    );
  }
}
