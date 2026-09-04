import { AsyncLocalStorage } from "node:async_hooks";

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  music06LastFmPlannerCapability,
  type Music06LastFmPlannerCapability,
} from "@/services/data-policy";
import {
  LastFmClient,
  type LastFmRecentTracksPage,
} from "@/services/lastfm/client";

import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import {
  readLastFmRecentObservation,
  type LastFmRecentTracksReader,
} from "./lastfm-coverage-reader";
import type { LastFmRecentObservation } from "./lastfm-coverage";
import {
  buildMusic06LastFmGapShadowReport,
  type Music06LastFmGapReport,
} from "./lastfm-gap-shadow-report";
import {
  projectMusic06NegativeShadow,
  type Music06NegativeProjectionShadow,
} from "./lastfm-negative-projection-shadow";
import { applyMusic06PlannerInfluence } from "./lastfm-planner-influence";

export const MUSIC_06_PLANNER_RUNTIME_POLICY_VERSION =
  "music-06-gate5b-runtime-v1" as const;

export const DEFAULT_MUSIC_06_PLANNER_RUNTIME_CONFIG = Object.freeze({
  lookbackDays: 7,
  windowHours: 6,
  maxSourceRuns: 28,
  maxCandidateRunsToRead: 200,
  maxProviderPages: 8,
  providerTimeoutMs: 8_000,
});

export type Music06PlannerRuntimePolicyReason =
  | "CAPABILITY_BLOCKED"
  | "MASTER_DISABLED"
  | "USER_EMAIL_MISSING"
  | "USER_NOT_ALLOWLISTED"
  | "ENABLED";

export type Music06PlannerRuntimePolicy = Readonly<{
  enabled: boolean;
  reason: Music06PlannerRuntimePolicyReason;
  userEmail: string | null;
  capability: Music06LastFmPlannerCapability;
}>;

export type Music06PlannerRuntimePreparationStatus =
  | "DISABLED"
  | "NOT_CONFIGURED"
  | "NO_PUBLISHED_RUNS"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_INCOMPLETE"
  | "READY";

type RuntimeSourceRun = Readonly<{
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  publishedAt: Date;
}>;

export type Music06PlannerRuntimePreparation = Readonly<{
  policyVersion: typeof MUSIC_06_PLANNER_RUNTIME_POLICY_VERSION;
  status: Music06PlannerRuntimePreparationStatus;
  policy: Music06PlannerRuntimePolicy;
  asOf: Date;
  projection: Music06NegativeProjectionShadow | null;
  sourceRunIds: readonly string[];
  selectedTargetCount: number;
  observation: Readonly<{
    requestedFrom: Date;
    requestedTo: Date;
    pagesFetched: number;
    totalPages: number;
    scrobbleCount: number;
  }> | null;
  failure: string | null;
}>;

export type Music06PlannerRuntimeOrderableItem = Readonly<{
  uri: string;
  type: "MUSIC" | "PODCAST";
  position: number;
  planningBlockIndex?: number;
  title?: string | null;
  subtitle?: string | null;
  spotifyTrackId?: string | null;
  primaryArtistId?: string | null;
  primaryArtistName?: string | null;
}>;

export type Music06PlannerRuntimeState = {
  preparation: Music06PlannerRuntimePreparation;
  firstPartyPreferences: readonly FirstPartyPlaybackPreference[];
  applicationCount: number;
  groupEvaluationCount: number;
  candidateOccurrenceCount: number;
  influencedCandidateOccurrenceCount: number;
  trackProjectionInfluenceCount: number;
  artistProjectionInfluenceCount: number;
  explicitPreferenceSuppressedCount: number;
  maxObservedMusicRankShift: number;
  applied: boolean;
  applicationFailureCount: number;
  lastFailure: string | null;
};

const storage = new AsyncLocalStorage<Music06PlannerRuntimeState>();

export function resolveMusic06PlannerRuntimePolicy(input: {
  userEmail: string | null | undefined;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  capability?: Music06LastFmPlannerCapability;
}): Music06PlannerRuntimePolicy {
  const capability = input.capability ?? music06LastFmPlannerCapability();
  const userEmail = normalizeEmail(input.userEmail);

  if (!capability.boundedRerankAllowed) {
    return {
      enabled: false,
      reason: "CAPABILITY_BLOCKED",
      userEmail,
      capability,
    };
  }

  if (!parseBoolean(input.masterEnabled)) {
    return {
      enabled: false,
      reason: "MASTER_DISABLED",
      userEmail,
      capability,
    };
  }

  if (!userEmail) {
    return {
      enabled: false,
      reason: "USER_EMAIL_MISSING",
      userEmail: null,
      capability,
    };
  }

  const allowlist = new Set(
    String(input.allowlistedEmails ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((value): value is string => Boolean(value)),
  );
  if (!allowlist.has(userEmail)) {
    return {
      enabled: false,
      reason: "USER_NOT_ALLOWLISTED",
      userEmail,
      capability,
    };
  }

  return {
    enabled: true,
    reason: "ENABLED",
    userEmail,
    capability,
  };
}

/**
 * Prepares a bounded, read-only Last.fm negative projection for the next plan.
 *
 * Safety properties:
 * - feature flag + per-user allowlist before any provider read;
 * - no Spotify behavioral source;
 * - one broad Last.fm observation reused locally for every source run;
 * - source run windows cannot overlap, preventing one listening session from
 *   satisfying multiple generation occurrences;
 * - at most one CONFIRMED/evaluable target contributes from each run, selected
 *   without looking at negative count;
 * - provider errors/incomplete pagination fail open to no influence;
 * - no DB/provider write.
 */
export async function prepareMusic06PlannerRuntime(input: {
  userId: string;
  userEmail: string | null | undefined;
  asOf?: Date;
  prismaClient?: PrismaClient;
  lastFmClient?: LastFmRecentTracksReader;
  apiKey?: string | null;
  username?: string | null;
  masterEnabled?: string | null;
  allowlistedEmails?: string | null;
  lookbackDays?: number;
  windowHours?: number;
  maxSourceRuns?: number;
  maxCandidateRunsToRead?: number;
  maxProviderPages?: number;
  providerTimeoutMs?: number;
}): Promise<Music06PlannerRuntimePreparation> {
  const asOf = input.asOf ?? new Date();
  assertValidDate(asOf, "asOf");
  const userId = input.userId.trim();
  if (!userId) throw new Error("MUSIC-06 Gate 5B runtime requires userId");

  const policy = resolveMusic06PlannerRuntimePolicy({
    userEmail: input.userEmail,
    masterEnabled:
      input.masterEnabled ?? process.env.MUSIC_06_LASTFM_PLANNER_ENABLED,
    allowlistedEmails:
      input.allowlistedEmails ?? process.env.MUSIC_06_LASTFM_PLANNER_USER_EMAILS,
  });

  if (!policy.enabled) {
    return basePreparation({ status: "DISABLED", policy, asOf });
  }

  const apiKey = (input.apiKey ?? process.env.LASTFM_API_KEY ?? "").trim();
  const username = (input.username ?? process.env.LASTFM_USERNAME ?? "").trim();
  if (!apiKey && !input.lastFmClient) {
    return basePreparation({
      status: "NOT_CONFIGURED",
      policy,
      asOf,
      failure: "LASTFM_API_KEY_MISSING",
    });
  }
  if (!username) {
    return basePreparation({
      status: "NOT_CONFIGURED",
      policy,
      asOf,
      failure: "LASTFM_USERNAME_MISSING",
    });
  }

  const lookbackDays = positiveNumber(
    input.lookbackDays ?? DEFAULT_MUSIC_06_PLANNER_RUNTIME_CONFIG.lookbackDays,
    "lookbackDays",
  );
  const windowHours = positiveNumber(
    input.windowHours ?? DEFAULT_MUSIC_06_PLANNER_RUNTIME_CONFIG.windowHours,
    "windowHours",
  );
  const maxSourceRuns = positiveInt(
    input.maxSourceRuns ?? DEFAULT_MUSIC_06_PLANNER_RUNTIME_CONFIG.maxSourceRuns,
    "maxSourceRuns",
  );
  const maxCandidateRunsToRead = positiveInt(
    input.maxCandidateRunsToRead ??
      DEFAULT_MUSIC_06_PLANNER_RUNTIME_CONFIG.maxCandidateRunsToRead,
    "maxCandidateRunsToRead",
  );
  const maxProviderPages = positiveInt(
    input.maxProviderPages ??
      DEFAULT_MUSIC_06_PLANNER_RUNTIME_CONFIG.maxProviderPages,
    "maxProviderPages",
  );
  const providerTimeoutMs = positiveInt(
    input.providerTimeoutMs ??
      DEFAULT_MUSIC_06_PLANNER_RUNTIME_CONFIG.providerTimeoutMs,
    "providerTimeoutMs",
  );

  const client = input.prismaClient ?? defaultPrisma;
  const lookbackFrom = new Date(asOf.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await client.generationRun.findMany({
    where: {
      userId,
      simulation: false,
      status: { in: ["SUCCESS", "PARTIAL"] },
      startedAt: { gte: lookbackFrom, lt: asOf },
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: maxCandidateRunsToRead,
    select: {
      id: true,
      startedAt: true,
      finishedAt: true,
    },
  });

  const sourceRuns = selectNonOverlappingMusic06SourceRuns({
    rows: rows.map((row) => ({
      ...row,
      publishedAt: row.finishedAt ?? row.startedAt,
    })),
    asOf,
    lookbackFrom,
    windowHours,
    maxSourceRuns,
  });

  if (sourceRuns.length === 0) {
    return basePreparation({ status: "NO_PUBLISHED_RUNS", policy, asOf });
  }

  const requestedFrom = sourceRuns.reduce(
    (earliest, row) =>
      row.publishedAt < earliest ? row.publishedAt : earliest,
    sourceRuns[0]!.publishedAt,
  );

  try {
    const provider =
      input.lastFmClient ??
      new LastFmClient({
        apiKey,
        fetchImpl: timeoutFetch(providerTimeoutMs),
      });
    const observation = await readLastFmRecentObservation({
      client: provider,
      username,
      from: requestedFrom,
      to: asOf,
      observedAt: asOf,
      maxPages: maxProviderPages,
    });

    const observationSummary = {
      requestedFrom: observation.requestedFrom,
      requestedTo: observation.requestedTo,
      pagesFetched: observation.pagesFetched,
      totalPages: observation.totalPages,
      scrobbleCount: observation.scrobbles.length,
    };

    if (!observation.complete) {
      return basePreparation({
        status: "PROVIDER_INCOMPLETE",
        policy,
        asOf,
        sourceRunIds: sourceRuns.map((row) => row.id),
        observation: observationSummary,
        failure: "LASTFM_BROAD_WINDOW_INCOMPLETE",
      });
    }

    const cachedReader = readerFromCompleteObservation(observation);
    const conservativeReports: Music06LastFmGapReport[] = [];

    // Oldest first makes debugging/reporting stable; projection itself is order-independent.
    for (const sourceRun of [...sourceRuns].sort(
      (left, right) => left.publishedAt.getTime() - right.publishedAt.getTime(),
    )) {
      const report = await buildMusic06LastFmGapShadowReport({
        userId,
        generationRunId: sourceRun.id,
        username,
        lastFmClient: cachedReader,
        prismaClient: client,
        observedAt: asOf,
        maxPages: 1,
        defaultWindowHours: windowHours,
      });
      const selected = selectOneConservativeTarget(report);
      if (selected) conservativeReports.push(selected);
    }

    const projection = projectMusic06NegativeShadow({
      reports: conservativeReports,
      asOf,
    });

    return {
      policyVersion: MUSIC_06_PLANNER_RUNTIME_POLICY_VERSION,
      status: "READY",
      policy,
      asOf: new Date(asOf.getTime()),
      projection,
      sourceRunIds: sourceRuns.map((row) => row.id),
      selectedTargetCount: conservativeReports.length,
      observation: observationSummary,
      failure: null,
    };
  } catch (error) {
    return basePreparation({
      status: "PROVIDER_UNAVAILABLE",
      policy,
      asOf,
      sourceRunIds: sourceRuns.map((row) => row.id),
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createMusic06PlannerRuntimeState(input: {
  preparation: Music06PlannerRuntimePreparation;
  firstPartyPreferences?: readonly FirstPartyPlaybackPreference[];
}): Music06PlannerRuntimeState {
  return {
    preparation: input.preparation,
    firstPartyPreferences: input.firstPartyPreferences ?? [],
    applicationCount: 0,
    groupEvaluationCount: 0,
    candidateOccurrenceCount: 0,
    influencedCandidateOccurrenceCount: 0,
    trackProjectionInfluenceCount: 0,
    artistProjectionInfluenceCount: 0,
    explicitPreferenceSuppressedCount: 0,
    maxObservedMusicRankShift: 0,
    applied: false,
    applicationFailureCount: 0,
    lastFailure: null,
  };
}

export function runWithMusic06PlannerRuntimeState<T>(
  state: Music06PlannerRuntimeState,
  run: () => Promise<T>,
): Promise<T> {
  return storage.run(state, run);
}

export function currentMusic06PlannerRuntimeState(): Music06PlannerRuntimeState | null {
  return storage.getStore() ?? null;
}

/**
 * Synchronous post-ORDER-01 rerank hook used by playlist-ordering.
 * It never changes the candidate set and never moves an item across a
 * CALENDAR-02 planning block. Any unexpected runtime error abstains instead of
 * breaking generation.
 */
export function applyMusic06PlannerInfluenceForCurrentRun<
  T extends Music06PlannerRuntimeOrderableItem,
>(items: T[]): T[] {
  const state = currentMusic06PlannerRuntimeState();
  const projection = state?.preparation.projection ?? null;
  if (
    !state ||
    state.preparation.status !== "READY" ||
    !projection ||
    !state.preparation.policy.enabled
  ) {
    return items;
  }

  const applicationOrdinal = state.applicationCount;
  state.applicationCount += 1;
  state.candidateOccurrenceCount += items.length;

  try {
    const output = items.map((item) => ({ ...item })) as T[];
    const groups = groupOrderableIndices(items);

    for (const [groupKey, indices] of groups) {
      if (indices.length === 0) continue;
      const groupItems = indices.map((index) => items[index]!);
      const originalByKey = new Map<string, T>();
      const candidates = groupItems.map((item, localIndex) => {
        const candidateKey = [
          applicationOrdinal,
          groupKey,
          localIndex,
          item.uri,
        ].join("::");
        originalByKey.set(candidateKey, item);
        return {
          candidateKey,
          type: item.type,
          trackName: item.type === "MUSIC" ? clean(item.title) : null,
          artistName:
            item.type === "MUSIC"
              ? clean(item.primaryArtistName) ?? clean(item.subtitle)
              : null,
          spotifyTrackId:
            item.type === "MUSIC" ? clean(item.spotifyTrackId) : null,
          primaryArtistId:
            item.type === "MUSIC" ? clean(item.primaryArtistId) : null,
        } as const;
      });

      const result = applyMusic06PlannerInfluence({
        candidates,
        projection,
        firstPartyPreferences: state.firstPartyPreferences,
        capability: state.preparation.policy.capability,
      });

      state.groupEvaluationCount += 1;
      state.influencedCandidateOccurrenceCount += result.influencedCandidateCount;
      state.trackProjectionInfluenceCount += result.trackProjectionInfluenceCount;
      state.artistProjectionInfluenceCount += result.artistProjectionInfluenceCount;
      state.explicitPreferenceSuppressedCount +=
        result.explicitPreferenceSuppressedCount;
      state.maxObservedMusicRankShift = Math.max(
        state.maxObservedMusicRankShift,
        result.maxObservedMusicRankShift,
      );
      state.applied = state.applied || result.applied;

      result.candidates.forEach((candidate, localIndex) => {
        const globalIndex = indices[localIndex];
        if (globalIndex === undefined) {
          throw new Error("MUSIC-06 Gate 5B group cardinality changed");
        }
        const selected = originalByKey.get(candidate.candidateKey);
        if (!selected) {
          throw new Error("MUSIC-06 Gate 5B candidate identity was lost");
        }
        const slot = items[globalIndex]!;
        output[globalIndex] = {
          ...selected,
          position: slot.position,
          ...(slot.planningBlockIndex === undefined
            ? { planningBlockIndex: undefined }
            : { planningBlockIndex: slot.planningBlockIndex }),
        } as T;
      });
    }

    if (output.length !== items.length) {
      throw new Error("MUSIC-06 Gate 5B changed candidate cardinality");
    }
    return output;
  } catch (error) {
    state.applicationFailureCount += 1;
    state.lastFailure = error instanceof Error ? error.message : String(error);
    return items;
  }
}

export function music06PlannerRuntimeSummary(
  state: Music06PlannerRuntimeState,
): Record<string, unknown> {
  const preparation = state.preparation;
  return {
    policyVersion: MUSIC_06_PLANNER_RUNTIME_POLICY_VERSION,
    status: preparation.status,
    policy: {
      enabled: preparation.policy.enabled,
      reason: preparation.policy.reason,
      baselineRecommendationDecision:
        preparation.policy.capability.baselineRecommendationDecision,
      boundedRerankDecision:
        preparation.policy.capability.boundedRerankDecision,
      baselinePlannerEligibilityDecision:
        preparation.policy.capability.baselinePlannerEligibilityDecision,
      plannerEligibilityDecision:
        preparation.policy.capability.plannerEligibilityDecision,
      boundedRerankAllowed:
        preparation.policy.capability.boundedRerankAllowed,
      eligibilityChangeAllowed:
        preparation.policy.capability.eligibilityChangeAllowed,
      approvalScope: preparation.policy.capability.approval.scope,
      approvalIssue: preparation.policy.capability.approval.issue,
    },
    sourceRunCount: preparation.sourceRunIds.length,
    sourceRunIds: [...preparation.sourceRunIds],
    selectedTargetCount: preparation.selectedTargetCount,
    observation: preparation.observation
      ? {
          requestedFrom: preparation.observation.requestedFrom.toISOString(),
          requestedTo: preparation.observation.requestedTo.toISOString(),
          pagesFetched: preparation.observation.pagesFetched,
          totalPages: preparation.observation.totalPages,
          scrobbleCount: preparation.observation.scrobbleCount,
        }
      : null,
    projection: preparation.projection
      ? {
          assessedOccurrenceCount:
            preparation.projection.assessedOccurrenceCount,
          negativeOccurrenceCount:
            preparation.projection.negativeOccurrenceCount,
          duplicateOccurrenceCount:
            preparation.projection.duplicateOccurrenceCount,
          conflictingOccurrenceCount:
            preparation.projection.conflictingOccurrenceCount,
          unprojectableOccurrenceCount:
            preparation.projection.unprojectableOccurrenceCount,
          trackProjectionCount: preparation.projection.tracks.length,
          artistProjectionCount: preparation.projection.artists.length,
        }
      : null,
    application: {
      applicationCount: state.applicationCount,
      groupEvaluationCount: state.groupEvaluationCount,
      candidateOccurrenceCount: state.candidateOccurrenceCount,
      influencedCandidateOccurrenceCount:
        state.influencedCandidateOccurrenceCount,
      trackProjectionInfluenceCount: state.trackProjectionInfluenceCount,
      artistProjectionInfluenceCount: state.artistProjectionInfluenceCount,
      explicitPreferenceSuppressedCount:
        state.explicitPreferenceSuppressedCount,
      maxObservedMusicRankShift: state.maxObservedMusicRankShift,
      applied: state.applied,
      eligibilityChanged: false,
      applicationFailureCount: state.applicationFailureCount,
      lastFailure: state.lastFailure,
    },
    failure: preparation.failure,
  };
}

export function selectNonOverlappingMusic06SourceRuns(input: {
  rows: readonly RuntimeSourceRun[];
  asOf: Date;
  lookbackFrom: Date;
  windowHours: number;
  maxSourceRuns: number;
}): RuntimeSourceRun[] {
  assertValidDate(input.asOf, "asOf");
  assertValidDate(input.lookbackFrom, "lookbackFrom");
  const windowMs =
    positiveNumber(input.windowHours, "windowHours") * 60 * 60 * 1000;
  const maxSourceRuns = positiveInt(input.maxSourceRuns, "maxSourceRuns");

  const eligible = [...input.rows]
    .filter(
      (row) =>
        row.publishedAt >= input.lookbackFrom &&
        row.publishedAt < input.asOf,
    )
    .sort(
      (left, right) =>
        right.publishedAt.getTime() - left.publishedAt.getTime() ||
        right.id.localeCompare(left.id),
    );

  const selected: RuntimeSourceRun[] = [];
  for (const row of eligible) {
    if (selected.length >= maxSourceRuns) break;
    const overlaps = selected.some((current) =>
      windowsOverlap(row.publishedAt, current.publishedAt, windowMs),
    );
    if (!overlaps) selected.push(row);
  }
  return selected;
}

function selectOneConservativeTarget(
  report: Music06LastFmGapReport,
): Music06LastFmGapReport | null {
  const coverageByTargetId = new Map(
    report.coverage.targets.map((target) => [target.targetPlaylistId, target] as const),
  );
  const eligible = report.targets
    .flatMap((target) => {
      const coverage = coverageByTargetId.get(target.targetPlaylistId);
      if (
        target.coverageStatus !== "CONFIRMED" ||
        target.shadow.assessedWindowCount <= 0 ||
        coverage?.assessment.status !== "CONFIRMED"
      ) {
        return [];
      }
      return [{ target, coverage }];
    })
    .sort(
      (left, right) =>
        right.target.shadow.assessedWindowCount -
          left.target.shadow.assessedWindowCount ||
        right.coverage.assessment.matchedOccurrenceCount -
          left.coverage.assessment.matchedOccurrenceCount ||
        right.coverage.assessment.publishedOccurrenceCount -
          left.coverage.assessment.publishedOccurrenceCount ||
        left.target.targetPlaylistId.localeCompare(right.target.targetPlaylistId),
    );

  const chosen = eligible[0];
  if (!chosen) return null;

  return {
    ...report,
    coverage: {
      ...report.coverage,
      targets: [chosen.coverage],
    },
    assessedWindowCount: chosen.target.shadow.assessedWindowCount,
    inferredGapCount: chosen.target.shadow.inferredGapCount,
    targets: [chosen.target],
  };
}

function readerFromCompleteObservation(
  observation: LastFmRecentObservation,
): LastFmRecentTracksReader {
  if (!observation.complete) {
    throw new Error("MUSIC-06 cached Last.fm reader requires complete observation");
  }

  return {
    async getRecentTracksPage(input): Promise<LastFmRecentTracksPage> {
      const page = input.page ?? 1;
      if (page !== 1) {
        throw new Error("MUSIC-06 cached Last.fm reader only exposes one complete page");
      }
      const from = input.from ?? observation.requestedFrom;
      const to = input.to ?? observation.requestedTo;
      if (
        from < observation.requestedFrom ||
        to > observation.requestedTo ||
        from >= to
      ) {
        throw new Error("MUSIC-06 cached Last.fm request is outside prefetched window");
      }
      const events = observation.scrobbles.filter(
        (event) => event.playedAt >= from && event.playedAt <= to,
      );
      return {
        username: observation.username,
        page: 1,
        perPage: Math.max(1, events.length),
        totalPages: events.length > 0 ? 1 : 0,
        total: events.length,
        events,
        nowPlayingCount: 0,
        invalidCount: 0,
      };
    },
  };
}

function groupOrderableIndices<T extends Music06PlannerRuntimeOrderableItem>(
  items: readonly T[],
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key =
      item.planningBlockIndex === undefined
        ? "whole-target"
        : `block:${item.planningBlockIndex}`;
    const current = groups.get(key) ?? [];
    current.push(index);
    groups.set(key, current);
  });
  return groups;
}

function windowsOverlap(left: Date, right: Date, windowMs: number): boolean {
  const leftStart = left.getTime();
  const rightStart = right.getTime();
  return leftStart < rightStart + windowMs && rightStart < leftStart + windowMs;
}

function basePreparation(input: {
  status: Music06PlannerRuntimePreparationStatus;
  policy: Music06PlannerRuntimePolicy;
  asOf: Date;
  sourceRunIds?: readonly string[];
  selectedTargetCount?: number;
  observation?: Music06PlannerRuntimePreparation["observation"];
  failure?: string | null;
}): Music06PlannerRuntimePreparation {
  return {
    policyVersion: MUSIC_06_PLANNER_RUNTIME_POLICY_VERSION,
    status: input.status,
    policy: input.policy,
    asOf: new Date(input.asOf.getTime()),
    projection: null,
    sourceRunIds: input.sourceRunIds ?? [],
    selectedTargetCount: input.selectedTargetCount ?? 0,
    observation: input.observation ?? null,
    failure: input.failure ?? null,
  };
}

function timeoutFetch(timeoutMs: number): typeof fetch {
  return async (request, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(request, {
        ...init,
        signal: init?.signal ?? controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function parseBoolean(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function positiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MUSIC-06 Gate 5B runtime ${label} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`MUSIC-06 Gate 5B runtime ${label} must be positive`);
  }
  return value;
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`MUSIC-06 Gate 5B runtime requires valid ${label}`);
  }
}
