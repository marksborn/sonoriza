import assert from "node:assert/strict";
import test from "node:test";

import type { Gate5FResolvedDiscoveryCandidate } from "@/services/music-discovery/planner-discovery-gate5f";
import type { SpotifyDiscoveryResolution } from "@/services/music-discovery/spotify-resolution";

import {
  discoveriesForPilotTarget,
  isLikedDiscoveryPilotCandidate,
  mergeLikedPilotWithStandardDiscovery,
  resolveLikedDiscoveryPilotPolicy,
  toGate5FDiscoveryCandidate,
} from "./liked-discovery-pilot-runtime";
import type { LikedExpansionResolvedCandidate } from "./liked-discovery-expansion-shadow";

function standard(trackId: string): Gate5FResolvedDiscoveryCandidate {
  return {
    candidateKey: `standard:${trackId}`,
    candidate: {
      uri: `spotify:track:${trackId}`,
      type: "MUSIC",
      title: `Track ${trackId}`,
      subtitle: "Standard Artist",
      spotifyTrackId: trackId,
      primaryArtistId: "standard-artist",
      primaryArtistName: "Standard Artist",
      durationMs: 180000,
    },
    rawScore: 80,
    adjustedScore: 75,
    historyClass: "NEW_ARTIST",
    pathLabel: "ROOT_ARTIST",
    resolutionReason: "EXACT_ARTIST_WITH_REPRESENTATIVE_TRACK",
    isrc: null,
  };
}

function sourceFixture(): LikedExpansionResolvedCandidate {
  return {
    candidateKey: "candidate:choldra",
    providerArtistName: "Choldra",
    candidateArtistMbid: null,
    artistName: "Choldra",
    normalizedArtistName: "choldra",
    maxSimilarity: 1,
    supportingSeeds: 3,
    seedArtistNames: ["Chipset Zero", "EDC", "Lekhaina"],
    dominantSeed: {
      spotifyArtistId: "seed-chipset",
      artistName: "Chipset Zero",
      likedTrackCount: 5,
      affinity: 0.9,
      similarity: 1,
    },
    scoreCard: {
      category: "DESCOBERTA",
      candidateKey: "candidate:choldra",
      artistName: "Choldra",
      source: "LASTFM_SIMILAR_ARTIST",
      score: 98.3,
      eligible: true,
      components: {
        similarity: 1,
        seedArtistAffinity: 0.9,
        seedTrackAffinity: 0.9,
        sourceConfidence: 0.9,
      },
      reasons: [],
    },
    spotifyArtistId: "spotify-choldra",
    spotifyTrackId: "spotify-track-choldra",
    trackName: "Casulo",
    albumName: "Casulo",
    resolutionReason: "EXACT_ARTIST_WITH_REPRESENTATIVE_TRACK",
  };
}

function revalidationFixture(overrides: {
  artistId?: string;
  trackId?: string;
} = {}): SpotifyDiscoveryResolution {
  const artist = {
    id: overrides.artistId ?? "spotify-choldra",
    name: "Choldra",
    uri: `spotify:artist:${overrides.artistId ?? "spotify-choldra"}`,
    spotifyUrl: null,
  };
  return {
    candidateKey: "liked-pilot:candidate:choldra",
    status: "RESOLVED",
    reason: "EXACT_TRACK_ARTIST_MATCH",
    spotifyArtist: artist,
    spotifyTrack: {
      id: overrides.trackId ?? "spotify-track-choldra",
      name: "Casulo",
      uri: `spotify:track:${overrides.trackId ?? "spotify-track-choldra"}`,
      spotifyUrl: null,
      isrc: "BRTEST000001",
      artists: [artist],
      albumId: "album-choldra",
      albumName: "Casulo",
      durationMs: 201000,
    },
    alternatives: [],
  };
}

function likedCandidate(): Gate5FResolvedDiscoveryCandidate {
  return toGate5FDiscoveryCandidate({
    source: sourceFixture(),
    calibratedScore: 74.485,
    resolution: revalidationFixture(),
  });
}

test("Gate 6C is fail-closed until base runtime, master, user and target allowlists all agree", () => {
  assert.equal(
    resolveLikedDiscoveryPilotPolicy({
      baseDiscoveryEnabled: false,
      userEmail: "pilot@example.com",
      masterEnabled: "1",
      allowlistedEmails: "pilot@example.com",
      allowlistedTargetIds: "target-a",
    }).reason,
    "BASE_DISCOVERY_DISABLED",
  );
  assert.equal(
    resolveLikedDiscoveryPilotPolicy({
      baseDiscoveryEnabled: true,
      userEmail: "pilot@example.com",
      masterEnabled: "0",
      allowlistedEmails: "pilot@example.com",
      allowlistedTargetIds: "target-a",
    }).reason,
    "MASTER_DISABLED",
  );
  assert.equal(
    resolveLikedDiscoveryPilotPolicy({
      baseDiscoveryEnabled: true,
      userEmail: "pilot@example.com",
      masterEnabled: "1",
      allowlistedEmails: "other@example.com",
      allowlistedTargetIds: "target-a",
    }).reason,
    "USER_NOT_ALLOWLISTED",
  );
  assert.equal(
    resolveLikedDiscoveryPilotPolicy({
      baseDiscoveryEnabled: true,
      userEmail: "pilot@example.com",
      masterEnabled: "1",
      allowlistedEmails: "pilot@example.com",
      allowlistedTargetIds: "",
    }).reason,
    "TARGET_ALLOWLIST_EMPTY",
  );
  const enabled = resolveLikedDiscoveryPilotPolicy({
    baseDiscoveryEnabled: true,
    userEmail: " PILOT@example.com ",
    masterEnabled: "true",
    allowlistedEmails: "pilot@example.com",
    allowlistedTargetIds: "target-a,target-b,target-a",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.reason, "ENABLED");
  assert.deepEqual(new Set(enabled.targetIds), new Set(["target-a", "target-b"]));
});

test("Gate 6C hands the exact revalidated Spotify identity to Gate 5H", () => {
  const discovery = likedCandidate();
  assert.equal(discovery.candidateKey, "liked:candidate:choldra");
  assert.equal(discovery.adjustedScore, 74.485);
  assert.equal(discovery.rawScore, 98.3);
  assert.equal(discovery.pathLabel, "LIKED_SIMILAR_EXPLORATORY");
  assert.equal(discovery.candidate.uri, "spotify:track:spotify-track-choldra");
  assert.equal(discovery.candidate.spotifyTrackId, "spotify-track-choldra");
  assert.equal(discovery.candidate.primaryArtistId, "spotify-choldra");
  assert.equal(discovery.candidate.durationMs, 201000);
  assert.equal(discovery.isrc, "BRTEST000001");
  assert.equal(isLikedDiscoveryPilotCandidate(discovery), true);
});

test("Gate 6C refuses to materialize unresolved revalidation evidence", () => {
  const resolution: SpotifyDiscoveryResolution = {
    candidateKey: "liked-pilot:candidate:choldra",
    status: "NOT_FOUND",
    reason: "TRACK_NOT_FOUND",
    spotifyArtist: null,
    spotifyTrack: null,
    alternatives: [],
  };
  assert.throws(() =>
    toGate5FDiscoveryCandidate({
      source: sourceFixture(),
      calibratedScore: 74.485,
      resolution,
    }),
  );
});

test("Gate 6C LIKED candidates are visible only to explicitly allowlisted targets", () => {
  const liked = likedCandidate();
  const normal = standard("normal-1");
  const pool = [normal, liked];
  assert.deepEqual(
    discoveriesForPilotTarget(pool, "target-a", new Set(["target-a"])).map(
      (row) => row.candidateKey,
    ),
    [normal.candidateKey, liked.candidateKey],
  );
  assert.deepEqual(
    discoveriesForPilotTarget(pool, "target-b", new Set(["target-a"])).map(
      (row) => row.candidateKey,
    ),
    [normal.candidateKey],
  );
});

test("Gate 6C never duplicates a track already resolved by standard discovery", () => {
  const liked = likedCandidate();
  const duplicate = standard("spotify-track-choldra");
  const suppressed = mergeLikedPilotWithStandardDiscovery({
    standard: [duplicate],
    pilot: liked,
  });
  assert.equal(suppressed.duplicateSuppressed, true);
  assert.equal(suppressed.discoveries.length, 1);

  const merged = mergeLikedPilotWithStandardDiscovery({
    standard: [standard("normal-1")],
    pilot: liked,
  });
  assert.equal(merged.duplicateSuppressed, false);
  assert.equal(merged.discoveries.length, 2);
});
