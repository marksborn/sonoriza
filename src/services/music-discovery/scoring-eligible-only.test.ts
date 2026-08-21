import assert from "node:assert/strict";
import test from "node:test";

import type {
  DiscoveryArtistProfile,
  DiscoveryTrackProfile,
} from "./profile";
import { buildDiscoveryScoringReportEligibleOnly } from "./scoring-eligible-only";
import { buildDiscoveryScoringReport } from "./scoring";

const AS_OF = new Date("2026-08-21T14:00:00.000Z");

function artist(name: string, index: number): DiscoveryArtistProfile {
  return {
    artistName: name,
    playCount: 350 + index * 40,
    priorPlayCount: 340 + index * 40,
    plays30d: 6 + index,
    previous30d: 2,
    plays90d: 18 + index,
    plays365d: 45 + index,
    distinctTrackCount: 80 + index * 10,
    distinctListeningDays: 180 + index * 10,
    listeningDays30d: 5,
    previousListeningDays30d: 2,
    firstPlayedAt: new Date("2014-01-01T00:00:00.000Z"),
    lastPlayedAt: new Date("2026-08-10T00:00:00.000Z"),
    extendedEvidenceCount: 220,
    msPlayedEvidenceCount: 220,
    explicitSkipCount: 12 + index,
    explicitSkipRate: (12 + index) / 220,
    inferredSkipCount: index % 2,
    pendingInferredSkipCount: 0,
    momentumDelta30d: 4 + index,
    momentumListeningDayDelta30d: 3,
    momentumRatio30d: 2,
    daysSinceLastPlay: 11,
    rediscoveryGapDays: 220,
  };
}

function track(index: number, artistName: string): DiscoveryTrackProfile {
  const oldEnoughForRediscovery = index % 4 === 0;
  const cooldownEligible = index % 7 !== 0;
  const weakHistory = index % 13 === 0;
  const highSkip = index % 11 === 0;
  const playCount = weakHistory ? 2 : 18 + (index % 55);
  const extendedEvidenceCount = 60;
  const explicitSkipCount = highSkip ? 38 : index % 5;
  const lastPlayedAt = oldEnoughForRediscovery
    ? new Date("2024-12-01T00:00:00.000Z")
    : new Date("2026-07-15T00:00:00.000Z");

  return {
    spotifyTrackId: `track-${index}`,
    spotifyUri: `spotify:track:track-${index}`,
    trackName: `Track ${index}`,
    artistName,
    albumName: `Album ${index % 40}`,
    playCount,
    plays30d: oldEnoughForRediscovery ? 0 : index % 4,
    firstPlayedAt: new Date("2016-01-01T00:00:00.000Z"),
    lastPlayedAt,
    distinctListeningDays: weakHistory ? 2 : 10 + (index % 35),
    extendedEvidenceCount,
    msPlayedEvidenceCount: extendedEvidenceCount,
    explicitSkipCount,
    explicitSkipRate: explicitSkipCount / extendedEvidenceCount,
    inferredSkipCount: index % 17 === 0 ? 2 : 0,
    pendingInferredSkipCount: index % 29 === 0 ? 1 : 0,
    cooldownLastPlayedAt: lastPlayedAt,
    cooldownLastPlayedSource: "TIMELINE",
    cooldownEligible,
  };
}

test("eligible-only COMPLETE scoring is exactly equivalent to legacy Gate 2.1 output", () => {
  const artists = ["Alpha", "Beta", "Gamma", "Delta"].map(artist);
  const tracks = Array.from({ length: 2_500 }, (_, index) =>
    track(index, artists[index % artists.length]!.artistName),
  );
  const topN = Math.max(artists.length, tracks.length);
  const input = {
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN,
    artists,
    tracks,
    candidateUniverse: "COMPLETE" as const,
  };

  const legacy = buildDiscoveryScoringReport(input);
  const optimized = buildDiscoveryScoringReportEligibleOnly(input);

  assert.deepEqual(optimized, legacy);
  assert.ok(optimized.rediscoveryCandidates.length > 0);
  assert.ok(optimized.familiarCandidates.length > 0);
  assert.ok(
    optimized.rediscoveryCandidates.length + optimized.familiarCandidates.length <
      tracks.length,
  );
});

test("partial topN conservatively falls back to canonical scoring", () => {
  const artists = [artist("Alpha", 0), artist("Beta", 1)];
  const tracks = Array.from({ length: 40 }, (_, index) =>
    track(index, artists[index % artists.length]!.artistName),
  );
  const input = {
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 5,
    artists,
    tracks,
    candidateUniverse: "DIAGNOSTIC_PARTIAL" as const,
  };

  assert.deepEqual(
    buildDiscoveryScoringReportEligibleOnly(input),
    buildDiscoveryScoringReport(input),
  );
});
