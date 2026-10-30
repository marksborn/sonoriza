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
 * Gate 7B (#365): third, independent switch for productive Spotify writes.
 * Only the literal value APPROVED counts; anything else keeps real runs on
 * the fail-closed Gate 7 path.
 */
export function podcast08ProductiveWritesApproved(value: string | null | undefined): boolean {
  return value?.trim() === "APPROVED";
}

export function podcast08AllowlistedTargetIds(
  mode: string | null | undefined,
  allowlistCsv: string | null | undefined,
): ReadonlySet<string> {
  if (mode !== "ACTIVE") return new Set();
  return new Set((allowlistCsv ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

/**
 * Gate 7B: the band editor opens only for a target whose bands would actually
 * be honored by real runs. Saving non-ANY bands anywhere else would make
 * Gate 7 fail that target's real generation.
 */
export function podcast08BandEditingAllowedForTarget(
  env: Readonly<Record<string, string | undefined>>,
  targetId: string | null | undefined,
): boolean {
  if (!targetId || env.PODCAST08_DURATION_EDITOR_ENABLED !== "1") return false;
  if (!podcast08ProductiveWritesApproved(env.PODCAST08_PRODUCTIVE_WRITES)) return false;
  return podcast08AllowlistedTargetIds(
    env.PODCAST08_ACTIVE_MODE,
    env.PODCAST08_ACTIVE_TARGET_IDS,
  ).has(targetId);
}

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
  const allowlist = podcast08AllowlistedTargetIds(input.mode, input.targetAllowlist);
  if (allowlist.size === 0) return inactive("ABSTAIN_NO_EXPLICIT_ALLOWLIST");
  if (!allowlist.has(input.targetId)) return inactive("ABSTAIN_TARGET_NOT_ALLOWLISTED");
  if (!input.simulate && !input.productiveWritesApproved) {
    return inactive("ABSTAIN_REAL_WRITE_NOT_APPROVED");
  }
  if (input.compositionMode !== "SEQUENCE") return inactive("ABSTAIN_NOT_SEQUENCE");
  // #365: PER_EVENT targets are supported; the band of each sequence slot is
  // applied inside every event block. hasDurationBlocks stays for evidence.

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
 * Stateful / strict show order veto. planRun applies it only to a preserved
 * KEEP_FILLED prefix: fresh candidates are protected per show by the planner's
 * head-of-line rule (an earlier pending episode is never skipped to fit a band).
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
