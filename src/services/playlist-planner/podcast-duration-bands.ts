/**
 * PODCAST-08 (#365): pure, read-only duration band contract.
 *
 * Do not import this into the productive planner until persistence, fingerprint,
 * canonical eligibility and rollout gates have all been reviewed.
 *
 * Candidate.durationMs is already the effective listening duration produced
 * by PODCAST-02/04/05/09: an IN_PROGRESS episode may therefore be shorter than
 * its original duration. Never recompute resume state from raw provider data here.
 */
export type PodcastDurationBand = "ANY" | "SHORT" | "MEDIUM" | "LONG";
export type ClassifiedPodcastDurationBand = "SHORT" | "MEDIUM" | "LONG" | "UNKNOWN";

export type PodcastDurationBandLimits = Readonly<{
  shortMaxMinutes: number;
  mediumMaxMinutes: number;
}>;

export type PodcastDurationSequenceSlot =
  | Readonly<{ type: "MUSIC" }>
  | Readonly<{ type: "PODCAST"; podcastDurationBand: PodcastDurationBand }>;

export const DEFAULT_PODCAST_DURATION_BAND_LIMITS: PodcastDurationBandLimits =
  Object.freeze({ shortMaxMinutes: 30, mediumMaxMinutes: 60 });

/**
 * Validate user-configured whole-minute dividers before any planner use.
 * Reject malformed/NaN/inverted configuration rather than changing selection.
 * Bounds are a UI guardrail, not a policy to truncate episode duration.
 */
export function parsePodcastDurationBandLimits(
  value: unknown,
): PodcastDurationBandLimits | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const short = input.shortMaxMinutes;
  const medium = input.mediumMaxMinutes;
  if (
    typeof short !== "number" ||
    typeof medium !== "number" ||
    !Number.isInteger(short) ||
    !Number.isInteger(medium) ||
    short < 1 ||
    medium > 1440 ||
    short >= medium
  ) {
    return null;
  }
  return Object.freeze({ shortMaxMinutes: short, mediumMaxMinutes: medium });
}

/**
 * Legacy ["MUSIC","PODCAST"] (including m/p shorthand) maps all podcast slots
 * to ANY. New object slots are parsed strictly to avoid silently weakening a
 * malformed explicit band into ANY. No producer consumes this parser yet.
 */
export function parsePodcastDurationSequenceSlots(
  raw: unknown,
): PodcastDurationSequenceSlot[] {
  if (!Array.isArray(raw)) return [];
  const slots: PodcastDurationSequenceSlot[] = [];
  for (const value of raw) {
    const entry: Record<string, unknown> | null =
      typeof value === "string"
        ? { type: value }
        : value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
    if (!entry || typeof entry.type !== "string") return [];
    const type = entry.type.trim().toUpperCase();
    if (type === "MUSIC" || type === "M") {
      if (entry.podcastDurationBand !== undefined) return [];
      slots.push({ type: "MUSIC" });
      continue;
    }
    if (type === "PODCAST" || type === "P") {
      const rawBand = entry.podcastDurationBand ?? "ANY";
      if (
        rawBand !== "ANY" &&
        rawBand !== "SHORT" &&
        rawBand !== "MEDIUM" &&
        rawBand !== "LONG"
      ) {
        return [];
      }
      slots.push({ type: "PODCAST", podcastDurationBand: rawBand });
      continue;
    }
    return [];
  }
  return slots;
}

/** A missing/zero/invalid effective duration is UNKNOWN, not SHORT. */
export function classifyPodcastEffectiveDuration(
  effectiveDurationMs: number | null | undefined,
  limits: PodcastDurationBandLimits = DEFAULT_PODCAST_DURATION_BAND_LIMITS,
): ClassifiedPodcastDurationBand {
  if (
    !Number.isInteger(limits.shortMaxMinutes) ||
    !Number.isInteger(limits.mediumMaxMinutes) ||
    limits.shortMaxMinutes < 1 ||
    limits.mediumMaxMinutes > 1440 ||
    limits.shortMaxMinutes >= limits.mediumMaxMinutes
  ) {
    throw new RangeError("Invalid PODCAST-08 global duration band limits");
  }
  if (
    typeof effectiveDurationMs !== "number" ||
    !Number.isFinite(effectiveDurationMs) ||
    effectiveDurationMs <= 0
  ) {
    return "UNKNOWN";
  }
  if (effectiveDurationMs <= limits.shortMaxMinutes * 60_000) return "SHORT";
  if (effectiveDurationMs <= limits.mediumMaxMinutes * 60_000) return "MEDIUM";
  return "LONG";
}

/** ANY keeps legacy behavior; UNKNOWN cannot satisfy a specified band. */
export function podcastDurationMatchesBand(
  effectiveDurationMs: number | null | undefined,
  requested: PodcastDurationBand,
  limits: PodcastDurationBandLimits = DEFAULT_PODCAST_DURATION_BAND_LIMITS,
): boolean {
  return (
    requested === "ANY" ||
    classifyPodcastEffectiveDuration(effectiveDurationMs, limits) === requested
  );
}

/**
 * Fixed fallback v1 (MEDIUM prefers SHORT before LONG to avoid more long-form
 * content during a short-form slot). ANY is the final legacy escape hatch.
 * All canonical eligibility, per-show cap, cadence, calendar fit and replay
 * guards must already be satisfied before calling the selector below.
 */
export function podcastDurationFallbackOrder(
  requested: PodcastDurationBand,
): readonly PodcastDurationBand[] {
  switch (requested) {
    case "ANY":
      return ["ANY"];
    case "SHORT":
      return ["SHORT", "MEDIUM", "ANY"];
    case "MEDIUM":
      return ["MEDIUM", "SHORT", "LONG", "ANY"];
    case "LONG":
      return ["LONG", "MEDIUM", "ANY"];
  }
}

export type PodcastDurationSlotSelection<T> = Readonly<{
  selected: T | null;
  requestedBand: PodcastDurationBand;
  fallbackStepBand: PodcastDurationBand | null;
  selectedBand: ClassifiedPodcastDurationBand | null;
  fallbackApplied: boolean;
  reason: "PRIMARY_MATCH" | "NO_ELIGIBLE_EPISODE_IN_REQUESTED_BAND" | "NO_ELIGIBLE_EPISODE_AFTER_FALLBACK";
}>;

/**
 * Pure projection over candidates that have ALREADY passed all authoritative
 * eligibility and fit constraints. Preserves canonical candidate order within
 * each stage. Not wired into production, simulation or the scheduler in Gate 2.
 */
export function previewPodcastDurationSlot<T extends {
  durationMs: number | null | undefined;
}>(
  eligibleCandidatesInCanonicalOrder: readonly T[],
  requestedBand: PodcastDurationBand,
  limits: PodcastDurationBandLimits = DEFAULT_PODCAST_DURATION_BAND_LIMITS,
): PodcastDurationSlotSelection<T> {
  for (const step of podcastDurationFallbackOrder(requestedBand)) {
    const selected = eligibleCandidatesInCanonicalOrder.find((candidate) =>
      podcastDurationMatchesBand(candidate.durationMs, step, limits),
    );
    if (!selected) continue;
    return {
      selected,
      requestedBand,
      fallbackStepBand: step,
      selectedBand: classifyPodcastEffectiveDuration(selected.durationMs, limits),
      fallbackApplied: step !== requestedBand,
      reason:
        step === requestedBand
          ? "PRIMARY_MATCH"
          : "NO_ELIGIBLE_EPISODE_IN_REQUESTED_BAND",
    };
  }
  return {
    selected: null,
    requestedBand,
    fallbackStepBand: null,
    selectedBand: null,
    fallbackApplied: false,
    reason: "NO_ELIGIBLE_EPISODE_AFTER_FALLBACK",
  };
}
