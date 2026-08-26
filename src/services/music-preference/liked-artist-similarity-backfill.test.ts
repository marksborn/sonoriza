import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLikedArtistSimilarityBackfillPlan,
  buildLikedArtistSimilarityBackfillSnapshot,
  runLikedArtistSimilarityBackfill,
  type LikedArtistSimilarityBackfillSnapshot,
} from "./liked-artist-similarity-backfill";

const NOW = new Date("2026-08-25T23:55:00.000Z");

function snapshot(
  overrides: Partial<LikedArtistSimilarityBackfillSnapshot> = {},
): LikedArtistSimilarityBackfillSnapshot {
  return {
    generatedAt: NOW,
    activeAffinityArtists: 932,
    queryableAffinityArtists: 932,
    withoutArtistName: 0,
    successfulActiveSeeds: 25,
    pendingSources: 907,
    priorityReadySources: 907,
    retryableFailedSources: 0,
    cooldownBlockedSources: 0,
    staleSuccessfulSources: 0,
    coveragePct: 2.68,
    activeSeedRows: 25,
    activeSimilarityEdges: 250,
    distinctCandidates: 154,
    duplicateActiveSeedRows: 0,
    duplicateActiveEdgeRows: 0,
    priorityReadySourceIds: Array.from({ length: 907 }, (_, index) => `artist-${index + 26}`),
    retryableFailedSourceIds: [],
    ...overrides,
  };
}

test("snapshot separates successful coverage, ready work, cooldown and stale success", () => {
  const result = buildLikedArtistSimilarityBackfillSnapshot({
    affinities: [
      { spotifyArtistId: "fresh", artistName: "Fresh", active: true },
      { spotifyArtistId: "stale", artistName: "Stale", active: true },
      { spotifyArtistId: "cooldown", artistName: "Cooldown", active: true },
      { spotifyArtistId: "retry", artistName: "Retry", active: true },
      { spotifyArtistId: "inactive", artistName: "Inactive", active: true },
      { spotifyArtistId: "new", artistName: "New", active: true },
      { spotifyArtistId: "nameless", artistName: null, active: true },
      { spotifyArtistId: "disabled", artistName: "Disabled", active: false },
    ],
    seeds: [
      {
        sourceSpotifyArtistId: "fresh",
        active: true,
        lastFetchedAt: new Date("2026-08-20T00:00:00.000Z"),
        refreshAfter: new Date("2026-09-20T00:00:00.000Z"),
        lastError: null,
      },
      {
        sourceSpotifyArtistId: "stale",
        active: true,
        lastFetchedAt: new Date("2026-07-01T00:00:00.000Z"),
        refreshAfter: new Date("2026-08-20T00:00:00.000Z"),
        lastError: null,
      },
      {
        sourceSpotifyArtistId: "cooldown",
        active: true,
        lastFetchedAt: null,
        refreshAfter: new Date("2026-08-26T03:00:00.000Z"),
        lastError: "temporary provider failure",
      },
      {
        sourceSpotifyArtistId: "retry",
        active: true,
        lastFetchedAt: null,
        refreshAfter: new Date("2026-08-25T20:00:00.000Z"),
        lastError: "old provider failure",
      },
      {
        sourceSpotifyArtistId: "inactive",
        active: false,
        lastFetchedAt: new Date("2026-08-01T00:00:00.000Z"),
        refreshAfter: new Date("2026-09-01T00:00:00.000Z"),
        lastError: null,
      },
    ],
    edges: [
      { sourceSpotifyArtistId: "fresh", candidateKey: "name:a", active: true },
      { sourceSpotifyArtistId: "stale", candidateKey: "name:a", active: true },
      { sourceSpotifyArtistId: "stale", candidateKey: "name:b", active: true },
    ],
    now: NOW,
  });

  assert.equal(result.activeAffinityArtists, 7);
  assert.equal(result.queryableAffinityArtists, 6);
  assert.equal(result.withoutArtistName, 1);
  assert.equal(result.successfulActiveSeeds, 2);
  assert.equal(result.pendingSources, 4);
  assert.equal(result.priorityReadySources, 2);
  assert.deepEqual(result.priorityReadySourceIds, ["inactive", "new"]);
  assert.equal(result.retryableFailedSources, 1);
  assert.deepEqual(result.retryableFailedSourceIds, ["retry"]);
  assert.equal(result.cooldownBlockedSources, 1);
  assert.equal(result.staleSuccessfulSources, 1);
  assert.equal(result.activeSimilarityEdges, 3);
  assert.equal(result.distinctCandidates, 2);
  assert.equal(result.coveragePct, 33.33);
});

test("snapshot reports duplicate active rows instead of hiding technical duplication", () => {
  const result = buildLikedArtistSimilarityBackfillSnapshot({
    affinities: [{ spotifyArtistId: "a", artistName: "A", active: true }],
    seeds: [
      {
        sourceSpotifyArtistId: "a",
        active: true,
        lastFetchedAt: NOW,
        refreshAfter: new Date("2026-09-01T00:00:00.000Z"),
        lastError: null,
      },
      {
        sourceSpotifyArtistId: "a",
        active: true,
        lastFetchedAt: NOW,
        refreshAfter: new Date("2026-09-01T00:00:00.000Z"),
        lastError: null,
      },
    ],
    edges: [
      { sourceSpotifyArtistId: "a", candidateKey: "name:x", active: true },
      { sourceSpotifyArtistId: "a", candidateKey: "name:x", active: true },
    ],
    now: NOW,
  });

  assert.equal(result.duplicateActiveSeedRows, 1);
  assert.equal(result.duplicateActiveEdgeRows, 1);
});

test("preview calculates the current pilot backfill without provider calls or writes", async () => {
  let executeCalls = 0;
  const report = await runLikedArtistSimilarityBackfill(
    "user-1",
    { mode: "PREVIEW", batchBudget: 100, maxBatches: 10 },
    {
      now: () => NOW,
      loadSnapshot: async () => snapshot(),
      executeBatch: async () => {
        executeCalls += 1;
        throw new Error("PREVIEW must not execute provider batches");
      },
      sleep: async () => undefined,
    },
  );

  assert.equal(executeCalls, 0);
  assert.equal(report.status, "READY");
  assert.equal(report.plan.estimatedBatchesThisRun, 10);
  assert.equal(report.plan.estimatedProviderCallsThisRun, 907);
  assert.equal(report.plan.maxProviderCallsThisRun, 1000);
  assert.equal(report.plan.canCompleteThisRun, true);
  assert.equal(report.totals.providerCalls, 0);
  assert.equal(report.safety.previewProviderCalls, 0);
  assert.equal(report.safety.databaseWrites, false);
});

test("apply advances in bounded batches and reaches complete coverage", async () => {
  const snapshots = [
    snapshot({ successfulActiveSeeds: 782, pendingSources: 150, priorityReadySources: 150 }),
    snapshot({ successfulActiveSeeds: 782, pendingSources: 150, priorityReadySources: 150 }),
    snapshot({ successfulActiveSeeds: 882, pendingSources: 50, priorityReadySources: 50 }),
    snapshot({
      successfulActiveSeeds: 932,
      pendingSources: 0,
      priorityReadySources: 0,
      coveragePct: 100,
      activeSeedRows: 932,
    }),
  ];
  let snapshotIndex = 0;
  const requestedBudgets: number[] = [];

  const report = await runLikedArtistSimilarityBackfill(
    "user-1",
    { mode: "APPLY", batchBudget: 100, maxBatches: 2, batchPauseMs: 0 },
    {
      now: () => NOW,
      loadSnapshot: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!,
      executeBatch: async (_userId, options) => {
        requestedBudgets.push(options.sourceBudget);
        const isFirst = requestedBudgets.length === 1;
        return {
          selectedSources: options.sourceBudget,
          providerCalls: options.sourceBudget,
          successfulSources: options.sourceBudget,
          failedSources: 0,
          beforeActiveSeeds: isFirst ? 782 : 882,
          afterActiveSeeds: isFirst ? 882 : 932,
          beforeActiveEdges: isFirst ? 7_820 : 8_820,
          afterActiveEdges: isFirst ? 8_820 : 9_320,
          failures: [],
        };
      },
      sleep: async () => undefined,
    },
  );

  assert.deepEqual(requestedBudgets, [100, 50]);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.batches.length, 2);
  assert.equal(report.totals.providerCalls, 150);
  assert.equal(report.totals.successfulSources, 150);
  assert.equal(report.after.coveragePct, 100);
  assert.equal(report.safety.databaseWrites, true);
  assert.equal(report.safety.plannerInfluence, false);
  assert.equal(report.safety.spotifyWrites, false);
});

test("provider failure guard stops a systemic outage after one batch", async () => {
  const before = snapshot({
    successfulActiveSeeds: 832,
    pendingSources: 100,
    priorityReadySources: 100,
  });
  const after = snapshot({
    successfulActiveSeeds: 902,
    pendingSources: 30,
    priorityReadySources: 0,
    cooldownBlockedSources: 30,
    activeSeedRows: 932,
  });
  let loads = 0;
  let executeCalls = 0;

  const report = await runLikedArtistSimilarityBackfill(
    "user-1",
    { mode: "APPLY", batchBudget: 100, maxBatches: 10, batchPauseMs: 0 },
    {
      now: () => NOW,
      loadSnapshot: async () => (loads++ < 2 ? before : after),
      executeBatch: async () => {
        executeCalls += 1;
        return {
          selectedSources: 100,
          providerCalls: 100,
          successfulSources: 70,
          failedSources: 30,
          beforeActiveSeeds: 832,
          afterActiveSeeds: 932,
          beforeActiveEdges: 8_320,
          afterActiveEdges: 9_020,
          failures: [],
        };
      },
      sleep: async () => undefined,
    },
  );

  assert.equal(executeCalls, 1);
  assert.equal(report.status, "PROVIDER_FAILURE_GUARD");
  assert.equal(report.batches[0]?.failureRate, 0.3);
  assert.equal(report.totals.failedSources, 30);
});

test("retryable failures never mix with stale successful refreshes", async () => {
  const guarded = snapshot({
    successfulActiveSeeds: 930,
    pendingSources: 2,
    priorityReadySources: 0,
    retryableFailedSources: 2,
    retryableFailedSourceIds: ["retry-a", "retry-b"],
    staleSuccessfulSources: 12,
  });
  let executeCalls = 0;

  const report = await runLikedArtistSimilarityBackfill(
    "user-1",
    { mode: "APPLY", batchBudget: 100, maxBatches: 10 },
    {
      now: () => NOW,
      loadSnapshot: async () => guarded,
      executeBatch: async () => {
        executeCalls += 1;
        throw new Error("guarded backfill must not refresh unrelated stale sources");
      },
      sleep: async () => undefined,
    },
  );

  assert.equal(executeCalls, 0);
  assert.equal(report.status, "STALE_REFRESH_INTERFERENCE_GUARD");
  assert.equal(report.safety.databaseWrites, false);
});

test("a completed backfill is idempotent and performs zero provider calls", async () => {
  const complete = snapshot({
    successfulActiveSeeds: 932,
    pendingSources: 0,
    priorityReadySources: 0,
    retryableFailedSources: 0,
    cooldownBlockedSources: 0,
    coveragePct: 100,
    activeSeedRows: 932,
  });
  let executeCalls = 0;

  const report = await runLikedArtistSimilarityBackfill(
    "user-1",
    { mode: "APPLY", batchBudget: 100, maxBatches: 10 },
    {
      now: () => NOW,
      loadSnapshot: async () => complete,
      executeBatch: async () => {
        executeCalls += 1;
        throw new Error("completed backfill must be a no-op");
      },
      sleep: async () => undefined,
    },
  );

  assert.equal(executeCalls, 0);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.batches.length, 0);
  assert.equal(report.totals.providerCalls, 0);
  assert.equal(report.safety.databaseWrites, false);
});

test("plan reflects cooldown as non-completable work for the current run", () => {
  const plan = buildLikedArtistSimilarityBackfillPlan(
    snapshot({
      successfulActiveSeeds: 900,
      pendingSources: 32,
      priorityReadySources: 27,
      cooldownBlockedSources: 5,
      priorityReadySourceIds: Array.from({ length: 27 }, (_, index) => `p-${index}`),
    }),
    { batchBudget: 100, maxBatches: 10 },
  );

  assert.equal(plan.readySourcesNow, 27);
  assert.equal(plan.blockedByCooldown, 5);
  assert.equal(plan.estimatedProviderCallsThisRun, 27);
  assert.equal(plan.canCompleteThisRun, false);
});
