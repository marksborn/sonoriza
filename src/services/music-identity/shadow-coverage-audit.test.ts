import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMusicIdentityShadowCoverage,
  type ShadowCoverageSourceRow,
} from "./shadow-coverage-audit";

function fullCache(
  candidates: Array<{
    id: string;
    title: string;
    artistId?: string;
    artistName?: string;
  }>,
  unavailableTrackCount = 0,
) {
  return {
    version: 5,
    unavailableTrackCount,
    candidates: candidates.map((candidate) => ({
      uri: `spotify:track:${candidate.id}`,
      spotifyTrackId: candidate.id,
      title: candidate.title,
      subtitle: null,
      primaryArtistId: candidate.artistId ?? null,
      primaryArtistName: candidate.artistName ?? null,
      albumId: null,
      albumName: null,
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
  kind: "MUSIC" | "PODCAST",
  enabled: boolean,
  cachedCandidates: unknown,
): ShadowCoverageSourceRow {
  return {
    id,
    name: id,
    kind,
    enabled,
    cachedCandidates,
    spotifySnapshotId: cachedCandidates == null ? null : `snapshot-${id}`,
    cacheUpdatedAt: cachedCandidates == null ? null : new Date("2026-09-19T12:00:00Z"),
  };
}

test("Gate 2C reports persisted cache coverage without treating a partial cache as complete", () => {
  const summary = buildMusicIdentityShadowCoverage({
    userId: "user-1",
    sources: [
      source(
        "music-full",
        "MUSIC",
        true,
        fullCache(
          [
            { id: "track-a", title: "A", artistId: "artist-a", artistName: "Artist A" },
            { id: "track-b", title: "B", artistId: "artist-b", artistName: "Artist B" },
          ],
          1,
        ),
      ),
      source(
        "music-partial",
        "MUSIC",
        true,
        partialCache([
          { id: "track-b", title: "B", artistId: "artist-b", artistName: "Artist B" },
          { id: "track-c", title: "C", artistId: "artist-c", artistName: "Artist C" },
        ]),
      ),
      source("music-missing", "MUSIC", true, null),
      source(
        "music-disabled",
        "MUSIC",
        false,
        fullCache([{ id: "track-d", title: "D", artistId: "artist-d", artistName: "Artist D" }]),
      ),
      source("podcast", "PODCAST", true, null),
    ],
    targets: [
      {
        id: "target-1",
        name: "Target",
        sourceScopeMode: "INHERIT_GLOBAL",
        sourceSelections: [],
      },
    ],
    canonicalRefs: [
      { providerTrackId: "track-a", executionStatus: "KNOWN" },
      { providerTrackId: "track-x", executionStatus: "KNOWN" },
    ],
    backfillEligibleTrackIds: new Set(["track-c"]),
  });

  assert.equal(summary.mode, "SHADOW_READ_ONLY");
  assert.equal(summary.authority.providerCalls, false);
  assert.equal(summary.authority.writes, false);
  assert.equal(summary.authority.liveSpotifySnapshotVerified, false);
  assert.equal(summary.authority.interpretation, "LOWER_BOUND_PARTIAL_OR_UNAVAILABLE");

  assert.deepEqual(summary.scope, {
    enabledTargets: 1,
    configuredMusicSources: 4,
    enabledMusicSources: 3,
    reachableMusicSources: 3,
    unreachableEnabledMusicSources: 0,
  });
  assert.equal(summary.cache.fullValidSources, 1);
  assert.equal(summary.cache.partialValidSources, 1);
  assert.equal(summary.cache.missingSources, 1);
  assert.equal(summary.cache.invalidSources, 0);
  assert.equal(summary.cache.candidateOccurrences, 4);
  assert.equal(summary.cache.distinctSpotifyTracks, 3);
  assert.equal(summary.cache.duplicateOccurrencesAcrossSources, 1);
  assert.equal(summary.cache.unavailableTrackCount, 1);

  assert.equal(summary.coverage.coveredDistinctTracks, 1);
  assert.equal(summary.coverage.missingCanonicalDistinctTracks, 2);
  assert.equal(summary.coverage.canonicalOutsidePersistedCache, 1);
  assert.equal(summary.coverage.basisPoints, 3333);
  assert.deepEqual(summary.gaps, {
    backfillEligibleTracks: 1,
    cacheOnlyBootstrapReadyTracks: 1,
    incompleteArtistMetadataTracks: 0,
  });
});

test("Gate 2C distinguishes complete persisted coverage from live Spotify authority", () => {
  const summary = buildMusicIdentityShadowCoverage({
    userId: "user-2",
    sources: [
      source(
        "music",
        "MUSIC",
        true,
        fullCache([{ id: "track-a", title: "A", artistId: "artist-a", artistName: "Artist A" }]),
      ),
    ],
    targets: [
      {
        id: "target-2",
        name: "Target",
        sourceScopeMode: "SELECTED_ONLY",
        sourceSelections: [{ sourcePlaylistId: "music" }],
      },
    ],
    canonicalRefs: [{ providerTrackId: "track-a", executionStatus: "KNOWN" }],
    backfillEligibleTrackIds: new Set(),
  });

  assert.equal(summary.authority.interpretation, "COMPLETE_PERSISTED_SNAPSHOT");
  assert.equal(summary.authority.liveSpotifySnapshotVerified, false);
  assert.equal(summary.coverage.basisPoints, 10_000);
  assert.equal(summary.coverage.missingCanonicalDistinctTracks, 0);
});

test("Gate 2C fails closed on invalid cache and classifies incomplete cache metadata", () => {
  const summary = buildMusicIdentityShadowCoverage({
    userId: "user-3",
    sources: [
      source(
        "music-incomplete",
        "MUSIC",
        true,
        fullCache([{ id: "track-z", title: "Z" }]),
      ),
      source("music-invalid", "MUSIC", true, { version: 999, candidates: [] }),
    ],
    targets: [
      {
        id: "target-3",
        name: "Target",
        sourceScopeMode: "INHERIT_GLOBAL",
        sourceSelections: [],
      },
    ],
    canonicalRefs: [],
    backfillEligibleTrackIds: new Set(),
  });

  assert.equal(summary.cache.invalidSources, 1);
  assert.equal(summary.coverage.missingCanonicalDistinctTracks, 1);
  assert.equal(summary.gaps.incompleteArtistMetadataTracks, 1);
  assert.deepEqual(summary.sampleMissing[0]?.missingMetadata, [
    "primaryArtistId",
    "primaryArtistName",
  ]);
});
