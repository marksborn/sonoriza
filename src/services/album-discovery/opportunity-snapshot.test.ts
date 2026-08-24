import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyApiError } from "@/services/spotify/errors";

import type { AlbumOpportunityCandidate } from "./opportunity";
import { isAlbumOpportunityTerminalProviderError } from "./opportunity-report";
import {
  ALBUM_OPPORTUNITY_SNAPSHOT_POLICY,
  assertAlbumOpportunitySnapshotRefreshUsable,
  hydrateAlbumOpportunitySnapshotCandidates,
  selectSnapshotCandidates,
  serializeAlbumOpportunitySnapshotPayload,
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
    ranked: [original],
  });

  assert.equal(payload.version, ALBUM_OPPORTUNITY_SNAPSHOT_POLICY.version);
  assert.equal(payload.generatedAt, "2026-08-24T01:00:00.000Z");
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

test("snapshot refresh rejects provider outage disguised as an empty recommendation set", () => {
  assert.throws(
    () =>
      assertAlbumOpportunitySnapshotRefreshUsable({
        candidateCount: 0,
        providerFailureCount: 4,
      }),
    /provider failure\(s\) and no candidates/,
  );

  assert.doesNotThrow(() =>
    assertAlbumOpportunitySnapshotRefreshUsable({
      candidateCount: 0,
      providerFailureCount: 0,
    }),
  );

  assert.doesNotThrow(() =>
    assertAlbumOpportunitySnapshotRefreshUsable({
      candidateCount: 3,
      providerFailureCount: 1,
    }),
  );
});

test("album opportunity report treats Spotify quota/rate-limit as terminal", () => {
  assert.equal(
    isAlbumOpportunityTerminalProviderError(spotifyError("QUOTA_EXCEEDED")),
    true,
  );
  assert.equal(
    isAlbumOpportunityTerminalProviderError(spotifyError("RATE_LIMITED")),
    true,
  );
  assert.equal(
    isAlbumOpportunityTerminalProviderError(spotifyError("HTTP_ERROR")),
    false,
  );
  assert.equal(isAlbumOpportunityTerminalProviderError(new Error("local")), false);
});
