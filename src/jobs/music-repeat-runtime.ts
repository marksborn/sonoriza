import { AsyncLocalStorage } from "node:async_hooks";

import type {
  MusicRepeatWindowUnit,
  Prisma,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { RequiredPolicyUsesEvaluation } from "@/services/data-policy";
import { LastFmClient } from "@/services/lastfm/client";
import {
  applyFirstPartyPlaybackPreferencesToMusicCandidates,
  type FirstPartyPlaybackPreference,
  type FirstPartyPlannerPreferenceEvidence,
} from "@/services/music-preference";
import { normalizeMusicIdentityText } from "@/services/music-preference/lastfm-coverage";
import { readLastFmRecentObservation } from "@/services/music-preference/lastfm-coverage-reader";
import type { Candidate, PlanRunResult } from "@/services/playlist-planner";
import {
  computeMusicRepeatCutoff,
  filterMusicCandidatesForRepeat,
  refreshMusicRepeatContext,
  type MusicRepeatContext,
  type RecentlyPlayedSyncResult,
} from "@/services/spotify/recently-played";

import {
  applyMusic07EligibilityToCandidates,
  offMusic07EligibilityRuntimeState,
  type Music07EligibilityRuntimeState,
} from "./music-exposure-runtime";
import { revalidateTargetDiscoveryPoliciesBeforeRealWrite } from "./target-discovery-runtime";

export class MusicRepeatPreWriteBlockedError extends Error {
  readonly blockedCount: number;
  readonly missingIdentityCount: number;

  constructor(blockedCount: number, missingIdentityCount: number) {
    super(
      "A geração foi bloqueada antes de alterar o Spotify porque o histórico de reprodução mudou durante o planejamento.",
    );
    this.name = "MusicRepeatPreWriteBlockedError";
    this.blockedCount = blockedCount;
    this.missingIdentityCount = missingIdentityCount;
  }
}

export class LastFmFactualCooldownPreWriteBlockedError extends Error {
  readonly blockedCount: number;

  constructor(blockedCount: number) {
    super(
      "A geração foi bloqueada antes de alterar o Spotify porque uma ou mais músicas entraram no cooldown factual do Last.fm durante o planejamento.",
    );
    this.name = "LastFmFactualCooldownPreWriteBlockedError";
    this.blockedCount = blockedCount;
  }
}

export class LastFmFactualCooldownPreWriteUnavailableError extends Error {
  constructor(status: LastFmFactualCooldownStatus) {
    super(
      `A geração foi bloqueada antes de alterar o Spotify porque o cooldown factual do Last.fm não pôde ser revalidado (${status}).`,
    );
    this.name = "LastFmFactualCooldownPreWriteUnavailableError";
  }
}

export type LastFmFactualCooldownMode = "OFF" | "SHADOW" | "ACTIVE";

export type LastFmFactualCooldownStatus =
  | "OFF"
  | "USER_NOT_ALLOWLISTED"
  | "POLICY_DISABLED"
  | "POLICY_INCOMPLETE"
  | "NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_INCOMPLETE"
  | "READY_SHADOW"
  | "READY_ACTIVE";

export type LastFmFactualCooldownRuntimeState = {
  configuredMode: LastFmFactualCooldownMode;
  effectiveMode: LastFmFactualCooldownMode;
  status: LastFmFactualCooldownStatus;
  productiveInfluenceAllowed: boolean;
  windowValue: number | null;
  windowUnit: MusicRepeatWindowUnit | null;
  cutoff: Date | null;
  asOf: Date;
  blockedIdentityKeys: ReadonlySet<string>;
  localScrobbleCount: number;
  providerScrobbleCount: number;
  providerRequestedFrom: Date | null;
  providerRequestedTo: Date | null;
  providerPagesFetched: number;
  providerTotalPages: number;
  providerComplete: boolean | null;
  matchedCandidateCount: number;
  skippedCandidateCount: number;
  preWriteRevalidated: boolean;
  preWriteBlockedCount: number;
  failure: string | null;
};

export type MusicRepeatRunState = {
  userId: string;
  simulate: boolean;
  context: MusicRepeatContext;
  initialSync: RecentlyPlayedSyncResult;
  /** Gate 5C capability decision for Spotify Recently Played planner use. */
  repeatCompliance: RequiredPolicyUsesEvaluation;
  recentlyPlayedSkippedCount: number;
  missingTrackIdentitySkippedCount: number;
  preWriteSync: RecentlyPlayedSyncResult | null;
  preWriteRevalidated: boolean;
  preWriteBlockedCount: number;
  preWriteMissingIdentityCount: number;
  /** Factual Last.fm scrobbles used only for anti-repeat eligibility. */
  lastFmFactualCooldown?: LastFmFactualCooldownRuntimeState;
  /** MUSIC-07 Gate 3: absent state is fail-safe OFF for legacy callers/tests. */
  music07Eligibility?: Music07EligibilityRuntimeState;
  /** Gate 5B: authoritative explicit Sonoriza preferences for this run. */
  firstPartyPlaybackPreferences: readonly FirstPartyPlaybackPreference[];
  /** Latest deterministic application evidence; raw subject keys are not logged. */
  firstPartyPreferenceEvidence: FirstPartyPlannerPreferenceEvidence | null;
  /** SOURCE-LIKED-01 Gate 3B: observability only, never authoritative planner input. */
  likedTrackSourceShadow?: Record<string, unknown> | null;
};

const storage = new AsyncLocalStorage<MusicRepeatRunState>();

/**
 * The Last.fm factual cooldown is prepared before planner execution so every
 * candidate source sees the same snapshot. OFF and non-allowlisted users cause
 * no provider reads. The current Spotify Recently Played quarantine is not
 * relaxed by this path.
 */
export async function runWithMusicRepeatState<T>(
  state: MusicRepeatRunState,
  run: () => Promise<T>,
): Promise<T> {
  state.lastFmFactualCooldown ??=
    await prepareLastFmFactualCooldown(state.userId, new Date());

  const result = await storage.run(state, run);

  // Best-effort observability only. The base generation wrapper subsequently
  // merges the current summary, so this independent top-level evidence is kept.
  try {
    await appendLastFmFactualCooldownSummary(result, state.lastFmFactualCooldown);
  } catch {
    // Never convert a completed provider write into an API retry hazard.
  }

  return result;
}

export function currentMusicRepeatState(): MusicRepeatRunState | null {
  return storage.getStore() ?? null;
}

export function filterMusicBatchForCurrentRun(candidates: Candidate[]): {
  candidates: Candidate[];
  recentlyPlayedSkippedCount: number;
  missingTrackIdentitySkippedCount: number;
} {
  const state = currentMusicRepeatState();
  if (!state) {
    return {
      candidates,
      recentlyPlayedSkippedCount: 0,
      missingTrackIdentitySkippedCount: 0,
    };
  }

  // Gate 5C: Spotify Recently Played only affects planner eligibility when the
  // central capability matrix explicitly ALLOWs every required use. The current
  // matrix is REVIEW_REQUIRED, so the productive path is a no-op instead of
  // silently treating the historical cooldown projection as first-party.
  const repeatFiltered = state.repeatCompliance.allowed
    ? filterMusicCandidatesForRepeat(candidates, state.context)
    : {
        candidates,
        recentlyPlayedSkippedCount: 0,
        missingTrackIdentitySkippedCount: 0,
      };
  state.recentlyPlayedSkippedCount += repeatFiltered.recentlyPlayedSkippedCount;
  state.missingTrackIdentitySkippedCount +=
    repeatFiltered.missingTrackIdentitySkippedCount;

  // #278 PERSONAL profile: factual Last.fm scrobbles are an explicitly reviewed
  // source for operational planning / planner eligibility. This filter is not a
  // skip inference, preference, or MUSIC-07 exposure signal. Artist identity is
  // exact after normalization; track identity additionally ignores whitespace
  // so harmless catalogue differences such as "Dragon Fly" vs "Dragonfly"
  // resolve without fuzzy matching. SHADOW only measures.
  const lastFmFiltered = filterMusicCandidatesForLastFmFactualCooldown(
    repeatFiltered.candidates,
    state.lastFmFactualCooldown,
  );
  if (state.lastFmFactualCooldown) {
    state.lastFmFactualCooldown.matchedCandidateCount +=
      lastFmFiltered.matchedCandidateCount;
    state.lastFmFactualCooldown.skippedCandidateCount +=
      lastFmFiltered.skippedCandidateCount;
  }

  // MUSIC-07 Gate 3: exposure is an independent first-party eligibility anchor.
  // OFF/SHADOW are hard no-ops; ACTIVE can remove candidates only after the
  // rollout guards in music-exposure-runtime have explicitly authorized it.
  // Legacy callers that do not provide Gate 3 state default to OFF.
  const music07State =
    state.music07Eligibility ?? offMusic07EligibilityRuntimeState();
  const exposureEligible = applyMusic07EligibilityToCandidates(
    lastFmFiltered.candidates,
    music07State,
  );

  const firstParty = applyFirstPartyPlaybackPreferencesToMusicCandidates(
    exposureEligible,
    state.firstPartyPlaybackPreferences,
  );
  state.firstPartyPreferenceEvidence = firstParty.evidence;

  return {
    candidates: firstParty.candidates,
    recentlyPlayedSkippedCount: repeatFiltered.recentlyPlayedSkippedCount,
    missingTrackIdentitySkippedCount:
      repeatFiltered.missingTrackIdentitySkippedCount,
  };
}

/**
 * Called after the final plan has been computed but before it is returned to
 * the generator. Spotify Recently Played remains behind Gate 5C. ACTIVE factual
 * Last.fm cooldown is independently refreshed and can veto a stale real plan.
 */
export async function revalidateMusicRepeatBeforeRealWrite(
  plan: PlanRunResult,
): Promise<void> {
  const state = currentMusicRepeatState();

  if (
    state &&
    state.repeatCompliance.allowed &&
    !state.simulate &&
    state.context.enabled
  ) {
    const refreshed = await refreshMusicRepeatContext(state.userId, new Date());
    state.preWriteSync = refreshed.sync;
    state.context = refreshed.context;
    state.preWriteRevalidated = true;

    let blockedCount = 0;
    let missingIdentityCount = 0;
    for (const target of plan.targets) {
      for (const item of target.result.items) {
        if (item.type !== "MUSIC") continue;
        if (!item.spotifyTrackId) {
          missingIdentityCount += 1;
          continue;
        }
        if (refreshed.context.blockedTrackIds.has(item.spotifyTrackId)) {
          blockedCount += 1;
        }
      }
    }

    state.preWriteBlockedCount = blockedCount;
    state.preWriteMissingIdentityCount = missingIdentityCount;
    if (blockedCount > 0 || missingIdentityCount > 0) {
      throw new MusicRepeatPreWriteBlockedError(blockedCount, missingIdentityCount);
    }
  }

  if (
    state?.lastFmFactualCooldown?.effectiveMode === "ACTIVE" &&
    !state.simulate
  ) {
    const refreshed = await prepareLastFmFactualCooldown(state.userId, new Date());
    refreshed.preWriteRevalidated = true;
    state.lastFmFactualCooldown = refreshed;

    if (refreshed.effectiveMode !== "ACTIVE") {
      throw new LastFmFactualCooldownPreWriteUnavailableError(refreshed.status);
    }

    let blockedCount = 0;
    for (const target of plan.targets) {
      for (const item of target.result.items) {
        if (item.type !== "MUSIC") continue;
        const key = lastFmMusicIdentityKey(
          item.title,
          item.primaryArtistName ?? item.subtitle,
        );
        if (key && refreshed.blockedIdentityKeys.has(key)) blockedCount += 1;
      }
    }
    refreshed.preWriteBlockedCount = blockedCount;
    if (blockedCount > 0) {
      throw new LastFmFactualCooldownPreWriteBlockedError(blockedCount);
    }
  }

  await revalidateTargetDiscoveryPoliciesBeforeRealWrite();
}

export function filterMusicCandidatesForLastFmFactualCooldown(
  candidates: Candidate[],
  state: LastFmFactualCooldownRuntimeState | undefined,
): {
  candidates: Candidate[];
  matchedCandidateCount: number;
  skippedCandidateCount: number;
} {
  if (!state || state.blockedIdentityKeys.size === 0) {
    return {
      candidates,
      matchedCandidateCount: 0,
      skippedCandidateCount: 0,
    };
  }

  const active = state.effectiveMode === "ACTIVE";
  const eligible: Candidate[] = [];
  let matchedCandidateCount = 0;
  let skippedCandidateCount = 0;

  for (const candidate of candidates) {
    if (candidate.type !== "MUSIC") {
      eligible.push(candidate);
      continue;
    }

    const artistName = candidate.primaryArtistName ?? candidate.subtitle ?? null;
    const key = lastFmMusicIdentityKey(candidate.title, artistName);
    const matched = Boolean(key && state.blockedIdentityKeys.has(key));
    if (!matched) {
      eligible.push(candidate);
      continue;
    }

    matchedCandidateCount += 1;
    if (active) {
      skippedCandidateCount += 1;
      continue;
    }
    eligible.push(candidate);
  }

  return {
    candidates: eligible,
    matchedCandidateCount,
    skippedCandidateCount,
  };
}

export function lastFmMusicIdentityKey(
  trackName: string | null | undefined,
  artistName: string | null | undefined,
): string | null {
  const track = normalizeMusicIdentityText(trackName);
  const artist = normalizeMusicIdentityText(artistName);
  if (!track || !artist) return null;

  // Last.fm and Spotify occasionally differ only in whether a compound title
  // is written with a space (e.g. "Dragon Fly" vs "Dragonfly"). Keep artist
  // matching exact after normalization and compact only the track title. This
  // deliberately does not strip words, suffixes, versions or other metadata.
  const compactTrack = track.replace(/\s+/g, "");
  return `${artist}\u0000${compactTrack}`;
}

export async function prepareLastFmFactualCooldown(
  userId: string,
  asOf = new Date(),
): Promise<LastFmFactualCooldownRuntimeState> {
  const configuredMode = lastFmFactualModeFromEnv();
  if (configuredMode === "OFF") return offLastFmFactualCooldown(asOf);

  if (!csvSet(process.env.MUSIC_REPEAT_LASTFM_USER_IDS).has(userId)) {
    return baseLastFmFactualCooldown({
      configuredMode,
      effectiveMode: "OFF",
      status: "USER_NOT_ALLOWLISTED",
      asOf,
    });
  }

  const policy = await prisma.musicPlaybackPolicy.findUnique({
    where: { userId },
    select: {
      enabled: true,
      windowValue: true,
      windowUnit: true,
    },
  });

  if (!policy?.enabled) {
    return baseLastFmFactualCooldown({
      configuredMode,
      effectiveMode: "OFF",
      status: "POLICY_DISABLED",
      asOf,
    });
  }
  if (
    !Number.isInteger(policy.windowValue) ||
    (policy.windowValue ?? 0) < 1 ||
    !policy.windowUnit
  ) {
    return baseLastFmFactualCooldown({
      configuredMode,
      effectiveMode: "OFF",
      status: "POLICY_INCOMPLETE",
      asOf,
    });
  }

  const cutoff = computeMusicRepeatCutoff(
    asOf,
    policy.windowValue!,
    policy.windowUnit,
  );
  const apiKey = (process.env.LASTFM_API_KEY ?? "").trim();
  const username = (process.env.LASTFM_USERNAME ?? "").trim();
  if (!apiKey || !username) {
    return baseLastFmFactualCooldown({
      configuredMode,
      effectiveMode: "SHADOW",
      status: "NOT_CONFIGURED",
      asOf,
      windowValue: policy.windowValue,
      windowUnit: policy.windowUnit,
      cutoff,
      failure: !apiKey ? "LASTFM_API_KEY_MISSING" : "LASTFM_USERNAME_MISSING",
    });
  }

  const [localRows, handoff] = await Promise.all([
    prisma.trackListeningEvent.findMany({
      where: {
        userId,
        source: "LASTFM_SCROBBLE",
        playedAt: { gte: cutoff, lte: asOf },
      },
      select: {
        trackName: true,
        artistName: true,
        playedAt: true,
      },
    }),
    prisma.lastFmBackfillRun.findFirst({
      where: {
        userId,
        status: "SUCCESS",
        acceptedEvents: { gt: 0 },
      },
      orderBy: { to: "desc" },
      select: { to: true },
    }),
  ]);

  const blockedIdentityKeys = new Set<string>();
  for (const row of localRows) {
    const key = lastFmMusicIdentityKey(row.trackName, row.artistName);
    if (key) blockedIdentityKeys.add(key);
  }

  const providerRequestedFrom = laterDate(cutoff, handoff?.to ?? cutoff);
  let providerScrobbleCount = 0;
  let providerPagesFetched = 0;
  let providerTotalPages = 0;
  let providerComplete: boolean | null = true;

  if (providerRequestedFrom < asOf) {
    try {
      const observation = await readLastFmRecentObservation({
        client: new LastFmClient({ apiKey }),
        username,
        from: providerRequestedFrom,
        to: asOf,
        maxPages: positiveEnvInt(process.env.MUSIC_REPEAT_LASTFM_MAX_PAGES, 50),
      });
      providerScrobbleCount = observation.scrobbles.length;
      providerPagesFetched = observation.pagesFetched;
      providerTotalPages = observation.totalPages;
      providerComplete = observation.complete;
      for (const row of observation.scrobbles) {
        const key = lastFmMusicIdentityKey(row.trackName, row.artistName);
        if (key) blockedIdentityKeys.add(key);
      }

      if (!observation.complete) {
        return baseLastFmFactualCooldown({
          configuredMode,
          effectiveMode: "SHADOW",
          status: "PROVIDER_INCOMPLETE",
          asOf,
          windowValue: policy.windowValue,
          windowUnit: policy.windowUnit,
          cutoff,
          blockedIdentityKeys,
          localScrobbleCount: localRows.length,
          providerScrobbleCount,
          providerRequestedFrom,
          providerRequestedTo: asOf,
          providerPagesFetched,
          providerTotalPages,
          providerComplete,
          failure: "LASTFM_PAGINATION_INCOMPLETE",
        });
      }
    } catch (error) {
      return baseLastFmFactualCooldown({
        configuredMode,
        effectiveMode: "SHADOW",
        status: "PROVIDER_UNAVAILABLE",
        asOf,
        windowValue: policy.windowValue,
        windowUnit: policy.windowUnit,
        cutoff,
        blockedIdentityKeys,
        localScrobbleCount: localRows.length,
        providerRequestedFrom,
        providerRequestedTo: asOf,
        providerComplete: false,
        failure: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const effectiveMode = configuredMode === "ACTIVE" ? "ACTIVE" : "SHADOW";
  return baseLastFmFactualCooldown({
    configuredMode,
    effectiveMode,
    status: effectiveMode === "ACTIVE" ? "READY_ACTIVE" : "READY_SHADOW",
    asOf,
    windowValue: policy.windowValue,
    windowUnit: policy.windowUnit,
    cutoff,
    blockedIdentityKeys,
    localScrobbleCount: localRows.length,
    providerScrobbleCount,
    providerRequestedFrom,
    providerRequestedTo: asOf,
    providerPagesFetched,
    providerTotalPages,
    providerComplete,
  });
}

function baseLastFmFactualCooldown(input: {
  configuredMode: LastFmFactualCooldownMode;
  effectiveMode: LastFmFactualCooldownMode;
  status: LastFmFactualCooldownStatus;
  asOf: Date;
  windowValue?: number | null;
  windowUnit?: MusicRepeatWindowUnit | null;
  cutoff?: Date | null;
  blockedIdentityKeys?: ReadonlySet<string>;
  localScrobbleCount?: number;
  providerScrobbleCount?: number;
  providerRequestedFrom?: Date | null;
  providerRequestedTo?: Date | null;
  providerPagesFetched?: number;
  providerTotalPages?: number;
  providerComplete?: boolean | null;
  failure?: string | null;
}): LastFmFactualCooldownRuntimeState {
  return {
    configuredMode: input.configuredMode,
    effectiveMode: input.effectiveMode,
    status: input.status,
    productiveInfluenceAllowed: input.effectiveMode === "ACTIVE",
    windowValue: input.windowValue ?? null,
    windowUnit: input.windowUnit ?? null,
    cutoff: input.cutoff ?? null,
    asOf: input.asOf,
    blockedIdentityKeys: input.blockedIdentityKeys ?? new Set<string>(),
    localScrobbleCount: input.localScrobbleCount ?? 0,
    providerScrobbleCount: input.providerScrobbleCount ?? 0,
    providerRequestedFrom: input.providerRequestedFrom ?? null,
    providerRequestedTo: input.providerRequestedTo ?? null,
    providerPagesFetched: input.providerPagesFetched ?? 0,
    providerTotalPages: input.providerTotalPages ?? 0,
    providerComplete: input.providerComplete ?? null,
    matchedCandidateCount: 0,
    skippedCandidateCount: 0,
    preWriteRevalidated: false,
    preWriteBlockedCount: 0,
    failure: input.failure ?? null,
  };
}

function offLastFmFactualCooldown(asOf: Date): LastFmFactualCooldownRuntimeState {
  return baseLastFmFactualCooldown({
    configuredMode: "OFF",
    effectiveMode: "OFF",
    status: "OFF",
    asOf,
  });
}

function lastFmFactualModeFromEnv(): LastFmFactualCooldownMode {
  const raw = process.env.MUSIC_REPEAT_LASTFM_MODE?.trim().toUpperCase();
  if (raw === "SHADOW" || raw === "ACTIVE") return raw;
  return "OFF";
}

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[,;\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function positiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function laterDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}

function lastFmFactualCooldownSummary(
  state: LastFmFactualCooldownRuntimeState,
): Record<string, unknown> {
  return {
    policyVersion: "music-repeat-lastfm-factual-v1",
    source: "LASTFM_SCROBBLE",
    approvalIssue: 278,
    configuredMode: state.configuredMode,
    effectiveMode: state.effectiveMode,
    status: state.status,
    productiveInfluenceAllowed: state.productiveInfluenceAllowed,
    windowValue: state.windowValue,
    windowUnit: state.windowUnit,
    cutoff: state.cutoff?.toISOString() ?? null,
    asOf: state.asOf.toISOString(),
    blockedIdentityCount: state.blockedIdentityKeys.size,
    localScrobbleCount: state.localScrobbleCount,
    providerScrobbleCount: state.providerScrobbleCount,
    providerRequestedFrom: state.providerRequestedFrom?.toISOString() ?? null,
    providerRequestedTo: state.providerRequestedTo?.toISOString() ?? null,
    providerPagesFetched: state.providerPagesFetched,
    providerTotalPages: state.providerTotalPages,
    providerComplete: state.providerComplete,
    matchedCandidateCount: state.matchedCandidateCount,
    skippedCandidateCount: state.skippedCandidateCount,
    preWriteRevalidated: state.preWriteRevalidated,
    preWriteBlockedCount: state.preWriteBlockedCount,
    identityMethod: "TRACK_COMPACT_WHITESPACE_ARTIST_NORMALIZED_EXACT",
    failure: state.failure,
  };
}

async function appendLastFmFactualCooldownSummary(
  result: unknown,
  state: LastFmFactualCooldownRuntimeState,
): Promise<void> {
  if (!result || typeof result !== "object" || !("runId" in result)) return;
  const runId = (result as { runId?: unknown }).runId;
  if (typeof runId !== "string" || !runId) return;

  const row = await prisma.generationRun.findUnique({
    where: { id: runId },
    select: { summary: true },
  });
  const current =
    row?.summary && typeof row.summary === "object" && !Array.isArray(row.summary)
      ? (row.summary as Prisma.JsonObject)
      : {};

  await prisma.generationRun.update({
    where: { id: runId },
    data: {
      summary: {
        ...current,
        musicRepeatLastFmFactual: lastFmFactualCooldownSummary(state),
      } as Prisma.InputJsonValue,
    },
  });
}
