import {
  parsePodcastDurationBandLimits,
  type PodcastDurationBand,
  type PodcastDurationBandLimits,
} from "./podcast-duration-bands";
import { parsePersistedPodcastDurationSlots } from "./podcast-duration-persistence";
import type { Candidate, ContentType } from "./types";

export type Podcast08ActiveTargetPolicy = Readonly<{
  bands: readonly PodcastDurationBand[];
  limits: PodcastDurationBandLimits;
}>;

export type Podcast08GateResolution = Readonly<{
  status:
    | "OFF"
    | "ACTIVE_ALLOWED"
    | "ABSTAIN_NO_EXPLICIT_ALLOWLIST"
    | "ABSTAIN_TARGET_NOT_ALLOWLISTED"
    | "ABSTAIN_REAL_WRITE_NOT_APPROVED"
    | "ABSTAIN_INVALID_BANDS"
    | "ABSTAIN_INVALID_LIMITS"
    | "ABSTAIN_NOT_SEQUENCE"
    | "ABSTAIN_NOT_SINGLE_BLOCK"
    | "ABSTAIN_STATEFUL_ORDER";
  policy: Podcast08ActiveTargetPolicy | null;
}>;

/**
 * Gate 5: no implicit activation. The feature cannot affect a run unless
 * BOTH a deliberate mode and a per-target allowlist were supplied.
 *
 * Real Spotify updates require an independent third switch. This gate must
 * never infer approval from a successful simulation or a saved configuration.
 */
export function resolvePodcast08ActiveTargetPolicy(input: {
  mode: string | null | undefined;
  targetAllowlist: string | null | undefined;
  productiveWritesApproved: boolean;
  simulate: boolean;
  targetId: string;
  compositionMode: "PROPORTION" | "SEQUENCE";
  sequencePattern: readonly ContentType[];
  rawBands: unknown;
  limits: unknown;
  hasDurationBlocks: boolean;
}): Podcast08GateResolution {
  const inactive = (status: Podcast08GateResolution["status"]): Podcast08GateResolution =>
    { return { status, policy: null }; };
  if (input.mode !== "ACTIVE") return inactive("OFF");
  const allowlist = new Set(
    (input.targetAllowlist ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  );
  if (allowlist.size === 0) return inactive("ABSTAIN_NO_EXPLICIT_ALLOWLIST");
  if (!allowlist.has(input.targetId)) return inactive("ABSTAIN_TARGET_NOT_ALLOWLISTED");
  if (!input.simulate && !input.productiveWritesApproved) {
    return inactive("ABSTAIN_REAL_WRITE_NOT_APPROVED");
  }
  if (input.compositionMode !== "SEQUENCE") return inactive("ABSTAIN_NOT_SEQUENCE");
  if (input.hasDurationBlocks) return inactive("ABSTAIN_NOT_SINGLE_BLOCK");

  const bands = parsePersistedPodcastDurationSlots(
    input.sequencePattern, input.rawBands,
  );
  if (!bands || !bands.some((band) => band !== "ANY")) {
    return inactive("ABSTAIN_INVALID_BANDS");
  }
  const limits = parsePodcastDurationBandLimits(input.limits);
  if (!limits) return inactive("ABSTAIN_INVALID_LIMITS");
  return { status: "ACTIVE_ALLOWED", policy: { bands, limits } };
}

/**
 * Stateful / strict show order is an absolute veto in the v1 pilot.
 * The earlier canonical episode may not be skipped simply to fit a band.
 *
 * This is checked again at the last filtered candidate boundary, after all
 * Spotify sources and podcast cadence policies have been resolved.
 */
export function podcast08ActiveCandidateVeto(
  candidates: readonly Candidate[],
  preserved: readonly Candidate[],
): Podcast08GateResolution["status"] | null {
  const guarded = [...candidates, ...preserved].some((candidate) =>
    candidate.type === "PODCAST" &&
    (candidate.podcastStrictSequence === true ||
      candidate.podcastSequenceStateful === true),
  );
  return guarded ? "ABSTAIN_STATEFUL_ORDER" : null;
}
