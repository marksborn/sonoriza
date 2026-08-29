import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyCatalogRequestBudgetExceededError } from "@/services/spotify/catalog-read-session";
import { SpotifyApiError } from "@/services/spotify/errors";

import type { AlbumOpportunityCandidate } from "./opportunity";
import {
  isAlbumOpportunityResumableBudgetStop,
  isAlbumOpportunityTerminalProviderError,
} from "./opportunity-report";
import {
  ALBUM_OPPORTUNITY_SNAPSHOT_POLICY,
  assertAlbumOpportunitySnapshotRefreshUsable,
  hydrateAlbumOpportunitySnapshotCandidates,
  selectSnapshotCandidates,
  serializeAlbumOpportunitySnapshotPayload,
  shouldRefreshAlbumOpportunitySnapshot,
} from "./opportunity-snapshot";

function candidate(
  spotifyAlbumId: string,
  score: number,
  overrides: Partial<AlbumOpportunityCandidate> = {},
): AlbumOpportunityCandidate {
  return {
    spotifyAlbumId,
    albumName: `Album ${spotifyAlbumId}`,
    releaseDate: "2025-01-01",
    artistName: "Artist",
    artistDeepeningScore: 82,
    score,
    eligible: true,
    memoryState: null,
    coverage: {
      policyVersion: "album-gate1-profile-readonly-v1",
      spotifyAlbumId,
      albumName: `Album ${spotifyAlbumId}`,
      releaseDate: "2025-01-01",
      catalogTrackCount: 10,
      eligibleTrackCount: 10,
      unavailableTrackCount: 0,
      canonicalObservedTrackCount: 2,
      labelOnlyObservedTrackCount: 0,
      observedTrackCount: 2,
      canonicalCoverage: 0.2,
      analyticCoverage: 0.2,
      confidence: "CANONICAL_ONLY",
      matchedEventCount: 4,
      explicitSkipEventCount: 0,
      plays30d: 1,
      firstObservedAt: new Date("2025-01-02T03:04:05.000Z"),
      lastObservedAt: new Date("2026-08-20T12:34:56.000Z"),
    },
    components: {
      artistDeepening: 0.82,
      unexploredCoverage: 0.8,
      recentAlbumActivity: 0.3333,
      adjustedExplicitSkipRate: 0.12,
      negativePenalty: 0,
    },
    reasons: [
      {
        code: "HIGH_ARTIST_DEEPENING",
        detail: "artist deepening score 82",
      },
      {
        code: "LOW_ALBUM_COVERAGE",
        detail: "20% observed album coverage",
      },
    ],
    ...overrides,
  };
}

function spotifyError(kind: "RATE_LIMITED" | "QUOTA_EXCEEDED" | "HTTP_ERROR") {
  return new SpotifyApiError({
    kind,
    status: kind === "HTTP_ERROR" ? 500 : 429,
    method: "GET",
    operation: "spotify-api",
    reason: kind === "QUOTA_EXCEEDED" ? "QUOTA_EXCEEDED" : null,
    retryAfterSeconds: kind === "HTTP_ERROR" ? null : 60,
    retryable: kind !== "QUOTA_EXCEEDED",
    message: kind,
  });
}

test("snapshot serialization preserves ALBUM-01 candidate facts and restores Date fields", () => {
  const original = candidate("album-1", 77.4);
  const payload = serializeAlbumOpportunitySnapshotPayload({
    generatedAt: new Date("2026-08-24T01:00:00.000Z"),
    asOf: new Date("2026-08-24T00:59:00.000Z"),
    candidateCount: 9,
    providerFailureCount: 2,
    catalogProgress: {
      completeness: "COMPLETE",
      reason: null,
      nextRequestPath: null,
    },
    ranked: [original],
  });

  assert.equal(payload.version, ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.version);
  assert.equal(payload.generatedAt, "2026-08-24T01:00:00.000Z");
  assert.equal(payload.catalogProgress.completeness, "COMPLETE");
  assert.equal(payload.ranked[0]?.coverage.firstObservedAt, "2025-01-02T03:04:05.000Z");
  assert.equal(payload.ranked[0]?.coverage.lastObservedAt, "2026-08-20T12:34:56.000Z");

  const hydrated = hydrateAlbumOpportunitySnapshotCandidates(payload.ranked);
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0]?.spotifyAlbumId, original.spotifyAlbumId);
  assert.equal(
    hydrated[0]?.coverage.firstObservedAt?.toISOString(),
    original.coverage.firstObservedAt?.toISOString(),
  );
  assert.equal(
    hydrated[0]?.coverage.lastObservedAt?.toISOString(),
    original.coverage.lastObservedAt?.toISOString(),
  );
});

test("snapshot serialization preserves explicit partial catalog progress", () => {
  const payload = serializeAlbumOpportunitySnapshotPayload({
    generatedAt: new Date("2026-08-29T09:00:00.000Z"),
    asOf: new Date("2026-08-29T09:00:00.000Z"),
    candidateCount: 4,
    providerFailureCount: 0,
    catalogProgress: {
      completeness: "PARTIAL",
      reason: "REQUEST_BUDGET_EXHAUSTED",
      nextRequestPath: "/albums/next/tracks?limit=50",
    },
    ranked: [candidate("album-1", 90)],
  });

  assert.deepEqual(payload.catalogProgress, {
    completeness: "PARTIAL",
    reason: "REQUEST_BUDGET_EXHAUSTED",
    nextRequestPath: "/albums/next/tracks?limit=50",
  });
});

test("snapshot UI selection reapplies current QUEUED memory and backfills the top list", () => {
  const rows = [
    candidate("album-1", 90),
    candidate("album-2", 85),
    candidate("album-3", 80),
    candidate("album-4", 75),
    candidate("album-5", 70),
    candidate("album-6", 65),
  ];

  const selected = selectSnapshotCandidates(rows, new Set(["album-2", "album-4"]), 4);

  assert.deepEqual(
    selected.candidates.map((row) => row.spotifyAlbumId),
    ["album-1", "album-3", "album-5", "album-6"],
  );
  assert.equal(selected.suppressedAlbumCount, 2);
});

test("snapshot UI selection never mutates candidate ranking state", () => {
  const rows = [candidate("album-1", 90), candidate("album-2", 80)];
  const before = structuredClone(rows);

  selectSnapshotCandidates(rows, new Set(["album-1"]), 1);

  assert.deepEqual(rows, before);
});

test("snapshot refresh rejects provider outage or empty partial ranking", () => {
  assert.throws(
    () =>
      assertAlbumOpportunitySnapshotRefreshUsable({
        candidateCount: 0,
        providerFailureCount: 4,
        providerFailures: [
          { subject: "artist-a:catalog", error: "HTTP 500" },
          { subject: "artist-b:album-1", error: "invalid payload" },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /provider failure\(s\) and no candidates/);
      assert.match(error.message, /artist-a:catalog: HTTP 500/);
      assert.match(error.message, /artist-b:album-1: invalid payload/);
      return true;
    },
  );

  assert.throws(
    () =>
      assertAlbumOpportunitySnapshotRefreshUsable({
        candidateCount: 0,
        providerFailureCount: 0,
        catalogCompleteness: "PARTIAL",
      }),
    /partial snapshot refresh rejected/,
  );

  assert.doesNotThrow(() =>
    assertAlbumOpportunitySnapshotRefreshUsable({
      candidateCount: 0,
      providerFailureCount: 0,
      catalogCompleteness: "COMPLETE",
    }),
  );

  assert.doesNotThrow(() =>
    assertAlbumOpportunitySnapshotRefreshUsable({
      candidateCount: 3,
      providerFailureCount: 1,
      catalogCompleteness: "PARTIAL",
    }),
  );
});

test("partial snapshots always keep converging while fresh complete snapshots can wait", () => {
  assert.equal(
    shouldRefreshAlbumOpportunitySnapshot({ completeness: "PARTIAL", ageMs: 60_000 }),
    true,
  );
  assert.equal(
    shouldRefreshAlbumOpportunitySnapshot({
      completeness: "COMPLETE",
      ageMs: ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.refreshAfterMs - 1,
    }),
    false,
  );
  assert.equal(
    shouldRefreshAlbumOpportunitySnapshot({
      completeness: "COMPLETE",
      ageMs: ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.refreshAfterMs,
    }),
    true,
  );
});

test("local request budget becomes resumable only after a real candidate exists", () => {
  const budgetStop = new SpotifyCatalogRequestBudgetExceededError(
    4,
    4,
    "/albums/next/tracks?limit=50",
  );

  assert.equal(isAlbumOpportunityResumableBudgetStop(budgetStop, 1), true);
  assert.equal(isAlbumOpportunityResumableBudgetStop(budgetStop, 0), false);
  assert.equal(isAlbumOpportunityResumableBudgetStop(spotifyError("QUOTA_EXCEEDED"), 10), false);
});

test("album opportunity report treats provider quota and local request budget as terminal by default", () => {
  assert.equal(
    isAlbumOpportunityTerminalProviderError(spotifyError("QUOTA_EXCEEDED")),
    true,
  );
  assert.equal(
    isAlbumOpportunityTerminalProviderError(spotifyError("RATE_LIMITED")),
    true,
  );
  assert.equal(
    isAlbumOpportunityTerminalProviderError(
      new SpotifyCatalogRequestBudgetExceededError(8, 8),
    ),
    true,
  );
  assert.equal(
    isAlbumOpportunityTerminalProviderError(spotifyError("HTTP_ERROR")),
    false,
  );
  assert.equal(isAlbumOpportunityTerminalProviderError(new Error("local")), false);
});
