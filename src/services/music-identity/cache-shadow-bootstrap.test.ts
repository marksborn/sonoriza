import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCacheShadowBootstrapPlan,
  type CacheShadowBootstrapSourceRow,
} from "./cache-shadow-bootstrap";

function fullCache(
  candidates: Array<{
    id: string;
    title: string;
    artistId?: string;
    artistName?: string;
    albumId?: string;
    albumName?: string;
  }>,
) {
  return {
    version: 5,
    unavailableTrackCount: 0,
    candidates: candidates.map((candidate) => ({
      uri: `spotify:track:${candidate.id}`,
      spotifyTrackId: candidate.id,
      title: candidate.title,
      subtitle: null,
      primaryArtistId: candidate.artistId ?? null,
      primaryArtistName: candidate.artistName ?? null,
      albumId: candidate.albumId ?? null,
      albumName: candidate.albumName ?? null,
      durationMs: 180_000,
    })),
  };
}

function partialCache(
  candidates: Array<{ id: string; title: string; artistId: string; artistName: string }>,
) {
  return {
    version: 6,
    complete: false,
    unavailableTrackCount: 0,
    nextOffset: 50,
    candidates: candidates.map((candidate) => ({
      uri: `spotify:track:${candidate.id}`,
      spotifyTrackId: candidate.id,
      title: candidate.title,
      subtitle: null,
      primaryArtistId: candidate.artistId,
      primaryArtistName: candidate.artistName,
      albumId: null,
      albumName: null,
      durationMs: 180_000,
    })),
  };
}

function source(
  id: string,
  cachedCandidates: unknown,
  options: { enabled?: boolean; updatedAt?: Date | null } = {},
): CacheShadowBootstrapSourceRow {
  return {
    id,
    name: id,
    kind: "MUSIC",
    enabled: options.enabled ?? true,
    cachedCandidates,
    spotifySnapshotId: cachedCandidates == null ? null : `snapshot-${id}`,
    cacheUpdatedAt:
      options.updatedAt === undefined
        ? new Date("2026-09-19T12:00:00.000Z")
        : options.updatedAt,
  };
}

test("Gate 2D selects only cache-only bootstrap-ready tracks and fails closed on conflicts", () => {
  const plan = buildCacheShadowBootstrapPlan({
    sources: [
      source(
        "source-a",
        fullCache([
          {
            id: "track-ready",
            title: "Ready",
            artistId: "artist-ready",
            artistName: "Artist Ready",
            albumId: "album-ready",
            albumName: "Album Ready",
          },
          {
            id: "track-existing",
            title: "Existing",
            artistId: "artist-existing",
            artistName: "Artist Existing",
          },
          {
            id: "track-2b",
            title: "Backfill",
            artistId: "artist-2b",
            artistName: "Artist 2B",
          },
          { id: "track-incomplete", title: "Incomplete" },
          {
            id: "track-conflict",
            title: "Conflict",
            artistId: "artist-a",
            artistName: "Artist A",
          },
        ]),
      ),
      source(
        "source-b",
        fullCache([
          {
            id: "track-ready",
            title: "Ready",
            artistId: "artist-ready",
            artistName: "Artist Ready",
            albumId: "album-ready",
            albumName: "Album Ready",
          },
          {
            id: "track-conflict",
            title: "Conflict",
            artistId: "artist-b",
            artistName: "Artist B",
          },
        ]),
        { updatedAt: new Date("2026-09-19T13:00:00.000Z") },
      ),
    ],
    targets: [
      {
        id: "target",
        name: "Target",
        sourceScopeMode: "INHERIT_GLOBAL",
        sourceSelections: [],
      },
    ],
    canonicalTrackIds: new Set(["track-existing"]),
    backfillEligibleTrackIds: new Set(["track-2b"]),
  });

  assert.equal(plan.snapshotWriteAllowed, true);
  assert.equal(plan.abstentionReason, null);
  assert.equal(plan.fullValidSources, 2);
  assert.equal(plan.distinctSpotifyTracks, 5);
  assert.equal(plan.alreadyCanonicalOperationalTracks, 1);
  assert.equal(plan.excludedBackfillEligibleTracks, 1);
  assert.equal(plan.candidateTracks, 1);
  assert.equal(plan.skippedIncompleteTracks, 1);
  assert.equal(plan.skippedConflictTracks, 1);
  assert.equal(plan.candidates[0]?.spotifyTrackId, "track-ready");
  assert.equal(plan.candidates[0]?.observedAt.toISOString(), "2026-09-19T13:00:00.000Z");
  assert.deepEqual(plan.candidates[0]?.sourcePlaylistIds, ["source-a", "source-b"]);
  assert.deepEqual(plan.sampleConflicts[0]?.primaryArtistIds, ["artist-a", "artist-b"]);
});

test("Gate 2D refuses write authority when the persisted snapshot is partial or lacks timestamps", () => {
  const partial = buildCacheShadowBootstrapPlan({
    sources: [
      source(
        "source-partial",
        partialCache([
          { id: "track-a", title: "A", artistId: "artist-a", artistName: "Artist A" },
        ]),
      ),
    ],
    targets: [
      {
        id: "target",
        name: "Target",
        sourceScopeMode: "INHERIT_GLOBAL",
        sourceSelections: [],
      },
    ],
    canonicalTrackIds: new Set(),
    backfillEligibleTrackIds: new Set(),
  });

  assert.equal(partial.snapshotWriteAllowed, false);
  assert.equal(partial.abstentionReason, "INCOMPLETE_PERSISTED_SNAPSHOT");

  const missingTimestamp = buildCacheShadowBootstrapPlan({
    sources: [
      source(
        "source-no-time",
        fullCache([
          { id: "track-b", title: "B", artistId: "artist-b", artistName: "Artist B" },
        ]),
        { updatedAt: null },
      ),
    ],
    targets: [
      {
        id: "target",
        name: "Target",
        sourceScopeMode: "INHERIT_GLOBAL",
        sourceSelections: [],
      },
    ],
    canonicalTrackIds: new Set(),
    backfillEligibleTrackIds: new Set(),
  });

  assert.equal(missingTimestamp.snapshotWriteAllowed, false);
  assert.equal(missingTimestamp.abstentionReason, "MISSING_CACHE_TIMESTAMP");
  assert.equal(missingTimestamp.candidateTracks, 0);
  assert.equal(missingTimestamp.skippedIncompleteTracks, 1);
});

test("Gate 2D reuses TARGET-SCOPE-01 and ignores enabled sources outside SELECTED_ONLY scope", () => {
  const plan = buildCacheShadowBootstrapPlan({
    sources: [
      source(
        "selected",
        fullCache([
          { id: "track-selected", title: "Selected", artistId: "artist-s", artistName: "Artist S" },
        ]),
      ),
      source(
        "outside",
        fullCache([
          { id: "track-outside", title: "Outside", artistId: "artist-o", artistName: "Artist O" },
        ]),
      ),
    ],
    targets: [
      {
        id: "target",
        name: "Target",
        sourceScopeMode: "SELECTED_ONLY",
        sourceSelections: [{ sourcePlaylistId: "selected" }],
      },
    ],
    canonicalTrackIds: new Set(),
    backfillEligibleTrackIds: new Set(),
  });

  assert.deepEqual(plan.reachableSourceIds, ["selected"]);
  assert.equal(plan.distinctSpotifyTracks, 1);
  assert.equal(plan.candidateTracks, 1);
  assert.equal(plan.candidates[0]?.spotifyTrackId, "track-selected");
});
