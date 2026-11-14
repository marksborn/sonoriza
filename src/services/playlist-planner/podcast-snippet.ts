/**
 * PODCAST-SNIPPET (#559): episodes of up to 5 minutes that may take a MUSIC
 * position in the composition of a destination that opted in.
 *
 * A Snippet keeps being a podcast for identity, source scope, show policy,
 * cadence, per-show caps, listening state and history. Only its position in
 * the composition is musical (`compositionRole = "MUSIC"`).
 *
 * The classification uses the TOTAL episode duration. `Candidate.durationMs`
 * is the effective (remaining) duration for IN_PROGRESS episodes, so a 1 h
 * episode with 4 min left is never a Snippet. An unknown total never is.
 *
 * Rollout: `PODCAST_SNIPPET_MODE` is OFF by default. With OFF the per-target
 * checkbox is stored but ignored, and planning is byte-for-byte legacy: short
 * episodes remain eligible in PODCAST slots as before. Only ACTIVE applies the
 * checkbox, including its "unchecked excludes Snippets from PODCAST slots"
 * rule. This keeps a plain deploy from changing any existing playlist.
 */
import type { Candidate, ContentType } from "./types";

/** Fixed V1 boundary, inclusive: 5:00 is a Snippet, 5:00.001 is not. */
export const PODCAST_SNIPPET_MAX_DURATION_MS = 300_000;

/**
 * Music-role slots placed with real tracks before a Snippet may take the next
 * music-role slot. Internal and fixed: there is deliberately no user control
 * for Snippet frequency, and no minimum frequency is promised.
 */
export const PODCAST_SNIPPET_MIN_TRACKS_BETWEEN = 3;

export type PodcastSnippetMode = "OFF" | "ACTIVE";

/**
 * EXCLUDE: no Snippet is planned for the target, in any slot.
 * MUSIC_ROLE: Snippets may fill music positions; PODCAST slots keep using them
 * under the traditional rules (same URI is never placed twice).
 * Absent policy: legacy behavior (mode OFF).
 */
export type PodcastSnippetPolicy = "EXCLUDE" | "MUSIC_ROLE";

export function resolvePodcastSnippetMode(raw: string | undefined | null): PodcastSnippetMode {
  return raw?.trim().toUpperCase() === "ACTIVE" ? "ACTIVE" : "OFF";
}

export function resolvePodcastSnippetPolicy(input: {
  mode: PodcastSnippetMode;
  allowPodcastSnippets: boolean | null | undefined;
}): PodcastSnippetPolicy | undefined {
  if (input.mode !== "ACTIVE") return undefined;
  return input.allowPodcastSnippets === true ? "MUSIC_ROLE" : "EXCLUDE";
}

/**
 * Total duration of the episode, never the remaining time. Returns null when
 * the total is unknown: an IN_PROGRESS/partially played candidate without an
 * explicit original duration cannot be proven short.
 */
export function podcastSnippetTotalDurationMs(
  candidate: Pick<
    Candidate,
    | "type"
    | "durationMs"
    | "originalDurationMs"
    | "resumePositionMs"
    | "podcastListeningStatus"
  >,
): number | null {
  if (candidate.type !== "PODCAST") return null;
  if (candidate.originalDurationMs !== undefined && candidate.originalDurationMs !== null) {
    return validDuration(candidate.originalDurationMs);
  }
  const resumed =
    candidate.podcastListeningStatus === "IN_PROGRESS" ||
    (typeof candidate.resumePositionMs === "number" && candidate.resumePositionMs > 0);
  if (resumed) return null;
  return validDuration(candidate.durationMs);
}

export function isPodcastSnippet(
  candidate: Parameters<typeof podcastSnippetTotalDurationMs>[0],
): boolean {
  const total = podcastSnippetTotalDurationMs(candidate);
  return total !== null && total <= PODCAST_SNIPPET_MAX_DURATION_MS;
}

/** Composition position of an item; the factual `type` never changes. */
export function compositionRoleOf(
  item: Pick<Candidate, "type" | "compositionRole">,
): ContentType {
  return item.compositionRole ?? item.type;
}

/** A music-role item must be a valid Snippet episode; anything else is invalid. */
export function hasValidCompositionRole(
  item: Parameters<typeof podcastSnippetTotalDurationMs>[0] &
    Pick<Candidate, "compositionRole">,
): boolean {
  if (item.compositionRole === undefined || item.compositionRole === item.type) return true;
  return item.compositionRole === "MUSIC" && item.type === "PODCAST" && isPodcastSnippet(item);
}

export type PodcastSnippetTargetEvidence = {
  targetPlaylistId: string;
  /** null when mode is OFF: the checkbox is stored but not applied. */
  policy: PodcastSnippetPolicy | null;
  allowPodcastSnippets: boolean;
  /** Snippets planned in PODCAST positions (legacy behavior under OFF). */
  snippetsInPodcastRole: number;
  snippetsInMusicRole: number;
};

/**
 * Read-only evidence for the migration baseline (#559 checkpoint A): under
 * OFF, `snippetsInPodcastRole` counts exactly what an unchecked destination
 * would stop receiving once ACTIVE is enabled.
 */
export function podcastSnippetTargetEvidence(input: {
  targetPlaylistId: string;
  policy: PodcastSnippetPolicy | undefined;
  allowPodcastSnippets: boolean;
  items: ReadonlyArray<Parameters<typeof hasValidCompositionRole>[0]>;
}): PodcastSnippetTargetEvidence {
  let snippetsInPodcastRole = 0;
  let snippetsInMusicRole = 0;
  for (const item of input.items) {
    if (item.type !== "PODCAST" || !isPodcastSnippet(item)) continue;
    if (compositionRoleOf(item) === "MUSIC") snippetsInMusicRole += 1;
    else snippetsInPodcastRole += 1;
  }
  return {
    targetPlaylistId: input.targetPlaylistId,
    policy: input.policy ?? null,
    allowPodcastSnippets: input.allowPodcastSnippets,
    snippetsInPodcastRole,
    snippetsInMusicRole,
  };
}

/**
 * EXCLUDE as a pool filter, for callers with their own podcast selection
 * (event composition). An ordered show (strict/stateful) whose next episode
 * is a Snippet waits: its later episodes are dropped too, so they never jump
 * ahead of the excluded one.
 */
export function excludePodcastSnippetsFromPool(candidates: readonly Candidate[]): Candidate[] {
  const blockedOrderedPrograms = new Set<string>();
  const output: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.type !== "PODCAST") {
      output.push(candidate);
      continue;
    }
    const programId = candidate.programId?.trim() || null;
    const ordered =
      candidate.podcastStrictSequence === true || candidate.podcastSequenceStateful === true;
    if (ordered && programId && blockedOrderedPrograms.has(programId)) continue;
    if (isPodcastSnippet(candidate)) {
      if (ordered && programId) blockedOrderedPrograms.add(programId);
      continue;
    }
    output.push(candidate);
  }
  return output;
}

function validDuration(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}
