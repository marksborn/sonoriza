/**
 * AUDIOBOOK-02 D.8: entirely hypothetical, read-only mixture projection.
 *
 * IMPORTANT: This is NOT the Gate D planner, not Spotify catalogue evidence
 * and not the live Sonoriza selector. The samples are user-entered durations
 * without IDs or URIs; the output has no transferable write capability.
 */
import {
  previewUserDeclaredChapterDuration,
  type UserDeclaredChapterInput,
} from "./d6-self-reported-preview";

export const MANUAL_ADVISORY_EVIDENCE = "USER_DECLARED_UNVERIFIED" as const;
export const MANUAL_ADVISORY_CANDIDATES = "HYPOTHETICAL_USER_ENTERED_DURATIONS" as const;

export type ManualAdvisoryNotebook = Readonly<{
  userId: string;
  targetPlaylistId: string;
  revision: number;
  bookTitle: string;
  chapterLabel: string;
  chapterDurationMs: number;
  consumedMs: number;
  targetDurationMs: number;
  evidenceSource: string;
}>;
export type ManualAdvisoryTarget = Readonly<{
  id: string;
  userId: string;
  spotifyPlaylistId: string | null;
  durationMode: string;
  fixedDurationSeconds: number | null;
  compositionMode: string;
  updatePolicy: string;
  podcastPercent: number;
  hasVerifiedOverlay: boolean;
}>;
export type ManualAdvisoryInput = Readonly<{
  ownerId: string;
  expectedRevision: number;
  target: ManualAdvisoryTarget;
  notebook: ManualAdvisoryNotebook;
  sampleMusicDurationsMs: readonly number[];
  samplePodcastDurationsMs: readonly number[];
}>;

type NoWrites = Readonly<{
  durationEvidence: typeof MANUAL_ADVISORY_EVIDENCE;
  sampleEvidence: typeof MANUAL_ADVISORY_CANDIDATES;
  remoteBookPresenceVerified: false;
  chapterVerifiedBySpotify: false;
  plannerInfluence: false;
  approvalEligible: false;
  spotifyWrites: false;
  bindingEligible: false;
  persistentSimulation: false;
}>;

export type ManualAdvisoryResult =
  | Readonly<NoWrites & { status: "ABSTAIN"; reason: string }>
  | Readonly<NoWrites & {
      status: "READY_ADVISORY";
      targetPlaylistId: string;
      notebookRevision: number;
      bookTitle: string;
      chapterLabel: string;
      targetDurationMs: number;
      declaredChapterDurationMs: number;
      declaredConsumedMs: number;
      virtualChapterDurationMs: number;
      remainingBudgetMs: number;
      podcastPercentOfRemainingBudget: number;
      musicBudgetMs: number;
      podcastBudgetMs: number;
      hypotheticalMusicCount: number;
      hypotheticalPodcastCount: number;
      hypotheticalMusicDurationMs: number;
      hypotheticalPodcastDurationMs: number;
      hypotheticalExtrasMs: number;
      hypotheticalTotalVirtualDurationMs: number;
      budgetUnfilledMs: number;
      manualSpotifyControlRequired: true;
    }>;

const PROTECTION = {
  durationEvidence: MANUAL_ADVISORY_EVIDENCE,
  sampleEvidence: MANUAL_ADVISORY_CANDIDATES,
  remoteBookPresenceVerified: false,
  chapterVerifiedBySpotify: false,
  plannerInfluence: false,
  approvalEligible: false,
  spotifyWrites: false,
  bindingEligible: false,
  persistentSimulation: false,
} as const;

function abstain(reason: string): ManualAdvisoryResult {
  return { ...PROTECTION, status: "ABSTAIN", reason };
}

function validSamples(value: readonly number[]): boolean {
  return Array.isArray(value) && value.length <= 12 &&
    value.every(ms => Number.isSafeInteger(ms) && ms > 0 && ms <= 86_400_000);
}

/** Dry-run packing of hypothetical blocks against a fixed manual budget. */
function packSamples(samples: readonly number[], budgetMs: number) {
  let usedMs = 0;
  let count = 0;
  for (const durationMs of samples) {
    if (durationMs <= budgetMs - usedMs) {
      usedMs += durationMs;
      count++;
    }
  }
  return { usedMs, count };
}

/**
 * Never calls provider, DB, planner or writes. Requires owner+destination
 * identity, exact current notebook revision and unchanged target duration.
 */
export function projectUserDeclaredAudiobookAdvisory(
  input: ManualAdvisoryInput,
): ManualAdvisoryResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return abstain("INVALID_INPUT");
  }
  const { ownerId, notebook: n, target: t } = input;
  if (!ownerId?.trim() || !n || !t || n.userId !== ownerId ||
      t.userId !== ownerId || n.targetPlaylistId !== t.id ||
      !/^[A-Za-z0-9]{22}$/.test(t.spotifyPlaylistId ?? "")) {
    return abstain("OWNER_OR_DESTINATION_MISMATCH");
  }
  if (n.evidenceSource !== MANUAL_ADVISORY_EVIDENCE) {
    return abstain("INVALID_PROVENANCE");
  }
  if (!Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 || input.expectedRevision !== n.revision) {
    return abstain("STALE_OR_INVALID_NOTEBOOK_REVISION");
  }
  if (t.hasVerifiedOverlay) return abstain("VERIFIED_OVERLAY_PRESENT");
  if (t.durationMode !== "FIXED" || t.updatePolicy !== "MANUAL" ||
      t.compositionMode !== "PROPORTION" ||
      !Number.isSafeInteger(t.fixedDurationSeconds) ||
      !t.fixedDurationSeconds || t.fixedDurationSeconds <= 0 ||
      !Number.isSafeInteger(t.fixedDurationSeconds * 1000) ||
      t.fixedDurationSeconds * 1000 !== n.targetDurationMs ||
      !Number.isSafeInteger(t.podcastPercent) ||
      t.podcastPercent < 0 || t.podcastPercent > 100) {
    return abstain("TARGET_CONFIGURATION_UNSUPPORTED_OR_DRIFTED");
  }
  if (!validSamples(input.sampleMusicDurationsMs) ||
      !validSamples(input.samplePodcastDurationsMs) ||
      (input.sampleMusicDurationsMs.length === 0 &&
       input.samplePodcastDurationsMs.length === 0)) {
    return abstain("INVALID_HYPOTHETICAL_SAMPLES");
  }
  const selection: UserDeclaredChapterInput["selection"] =
    n.consumedMs === 0 ? { mode: "FULL_CHAPTER" } :
      { mode: "MANUAL_REMAINDER", consumedMs: n.consumedMs };
  const chapter = previewUserDeclaredChapterDuration({
    targetDurationMs: n.targetDurationMs,
    bookTitle: n.bookTitle,
    chapterLabel: n.chapterLabel,
    chapterDurationMs: n.chapterDurationMs,
    selection,
  });
  if (chapter.status !== "READY_MANUAL_PREVIEW") {
    return abstain("INVALID_SAVED_CHAPTER_" + chapter.reason);
  }
  // The user-declared audiobook consumes first from the fixed playlist budget.
  // The remaining portion is split only as an illustrative mix; no provider
  // candidates, URIs, cross-target reservations or actual rules are evaluated.
  const remaining = chapter.remainingPlanningDurationMs;
  const podcastBudget = Math.floor(remaining * t.podcastPercent / 100);
  const musicBudget = remaining - podcastBudget;
  const music = packSamples(input.sampleMusicDurationsMs, musicBudget);
  const podcasts = packSamples(input.samplePodcastDurationsMs, podcastBudget);
  const extras = music.usedMs + podcasts.usedMs;
  return {
    ...PROTECTION,
    status: "READY_ADVISORY",
    targetPlaylistId: t.id,
    notebookRevision: n.revision,
    bookTitle: chapter.bookTitle,
    chapterLabel: chapter.chapterLabel,
    targetDurationMs: chapter.targetDurationMs,
    declaredChapterDurationMs: chapter.declaredChapterDurationMs,
    declaredConsumedMs: chapter.declaredConsumedMs,
    virtualChapterDurationMs: chapter.effectivePlanningDurationMs,
    remainingBudgetMs: remaining,
    podcastPercentOfRemainingBudget: t.podcastPercent,
    musicBudgetMs: musicBudget,
    podcastBudgetMs: podcastBudget,
    hypotheticalMusicCount: music.count,
    hypotheticalPodcastCount: podcasts.count,
    hypotheticalMusicDurationMs: music.usedMs,
    hypotheticalPodcastDurationMs: podcasts.usedMs,
    hypotheticalExtrasMs: extras,
    hypotheticalTotalVirtualDurationMs: chapter.effectivePlanningDurationMs + extras,
    budgetUnfilledMs: remaining - extras,
    manualSpotifyControlRequired: true,
  };
}
