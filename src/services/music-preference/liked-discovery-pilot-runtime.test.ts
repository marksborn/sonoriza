import assert from "node:assert/strict";
import test from "node:test";

import type { Gate5FResolvedDiscoveryCandidate } from "@/services/music-discovery/planner-discovery-gate5f";
import type { SpotifyDiscoveryResolution } from "@/services/music-discovery/spotify-resolution";

import {
  discoveriesForPilotTarget,
  isLikedDiscoveryPilotCandidate,
  mergeLikedPilotWithStandardDiscovery,
  resolveLikedDiscoveryPilotPolicy,
  resolveLikedDiscoveryPilotRuntime,
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

test("liked-discovery remains fail-closed through rollout checks and then source capability", () => {
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

  const quarantined = resolveLikedDiscoveryPilotPolicy({
    baseDiscoveryEnabled: true,
    userEmail: " PILOT@example.com ",
    masterEnabled: "true",
    allowlistedEmails: "pilot@example.com",
    allowlistedTargetIds: "target-a,target-b,target-a",
  });
  assert.equal(quarantined.enabled, false);
  assert.equal(quarantined.reason, "SOURCE_CAPABILITY_BLOCKED");
  assert.deepEqual(
    new Set(quarantined.targetIds),
    new Set(["target-a", "target-b"]),
  );
});

test("liked-discovery runtime exits before expansion or Spotify catalog acquisition", async () => {
  const result = await resolveLikedDiscoveryPilotRuntime({
    userId: "no-database-or-provider-access-needed",
    userEmail: "pilot@example.com",
    baseDiscoveryEnabled: true,
    masterEnabled: "true",
    allowlistedEmails: "pilot@example.com",
    allowlistedTargetIds: "target-a",
  });

  assert.equal(result.discovery, null);
  assert.equal(result.evidence.status, "DISABLED");
  assert.equal(result.evidence.reason, "SOURCE_CAPABILITY_BLOCKED");
  assert.equal(result.evidence.spotifyCatalogCalls, 0);
  assert.equal(result.evidence.revalidationSpotifyCatalogCalls, 0);
});

test("legacy pure handoff keeps exact revalidated Spotify identity for diagnostics", () => {
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

test("legacy pure handoff refuses unresolved revalidation evidence", () => {
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

test("legacy LIKED candidate target projection remains a pure diagnostic helper", () => {
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

test("legacy LIKED merge helper never duplicates an existing standard track", () => {
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
