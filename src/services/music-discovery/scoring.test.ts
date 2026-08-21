import assert from "node:assert/strict";
import test from "node:test";

import type {
  DiscoveryArtistProfile,
  DiscoveryTrackProfile,
} from "./profile";
import {
  buildDiscoveryScoringReport,
  scoreArtistProfile,
  scoreExternalDiscoveryCandidate,
} from "./scoring";

const AS_OF = new Date("2026-08-20T18:00:00.000Z");

function artist(
  input: Partial<DiscoveryArtistProfile> & Pick<DiscoveryArtistProfile, "artistName">,
): DiscoveryArtistProfile {
  return {
    artistName: input.artistName,
    playCount: input.playCount ?? 20,
    priorPlayCount: input.priorPlayCount ?? 20,
    plays30d: input.plays30d ?? 0,
    previous30d: input.previous30d ?? 0,
    plays90d: input.plays90d ?? input.plays30d ?? 0,
    plays365d: input.plays365d ?? input.plays90d ?? input.plays30d ?? 0,
    distinctTrackCount: input.distinctTrackCount ?? 10,
    distinctListeningDays: input.distinctListeningDays ?? 15,
    listeningDays30d: input.listeningDays30d ?? 0,
    previousListeningDays30d: input.previousListeningDays30d ?? 0,
    firstPlayedAt: input.firstPlayedAt ?? new Date("2015-01-01T00:00:00.000Z"),
    lastPlayedAt: input.lastPlayedAt ?? new Date("2026-01-01T00:00:00.000Z"),
    extendedEvidenceCount: input.extendedEvidenceCount ?? 20,
    msPlayedEvidenceCount: input.msPlayedEvidenceCount ?? input.extendedEvidenceCount ?? 20,
    explicitSkipCount: input.explicitSkipCount ?? 2,
    explicitSkipRate:
      input.explicitSkipRate ??
      (input.explicitSkipCount ?? 2) / (input.extendedEvidenceCount ?? 20),
    inferredSkipCount: input.inferredSkipCount ?? 0,
    pendingInferredSkipCount: input.pendingInferredSkipCount ?? 0,
    momentumDelta30d: input.momentumDelta30d ?? 0,
    momentumListeningDayDelta30d: input.momentumListeningDayDelta30d ?? 0,
    momentumRatio30d: input.momentumRatio30d ?? null,
    daysSinceLastPlay: input.daysSinceLastPlay ?? 200,
    rediscoveryGapDays: input.rediscoveryGapDays ?? null,
  };
}

function track(
  input: Partial<DiscoveryTrackProfile> &
    Pick<DiscoveryTrackProfile, "spotifyTrackId" | "trackName" | "artistName">,
): DiscoveryTrackProfile {
  const extendedEvidenceCount = input.extendedEvidenceCount ?? 20;
  const explicitSkipCount = input.explicitSkipCount ?? 1;
  return {
    spotifyTrackId: input.spotifyTrackId,
    spotifyUri: input.spotifyUri ?? `spotify:track:${input.spotifyTrackId}`,
    trackName: input.trackName,
    artistName: input.artistName,
    albumName: input.albumName ?? "Album",
    playCount: input.playCount ?? 20,
    plays30d: input.plays30d ?? 0,
    firstPlayedAt: input.firstPlayedAt ?? new Date("2015-01-01T00:00:00.000Z"),
    lastPlayedAt: input.lastPlayedAt ?? new Date("2026-01-01T00:00:00.000Z"),
    distinctListeningDays: input.distinctListeningDays ?? 18,
    extendedEvidenceCount,
    msPlayedEvidenceCount: input.msPlayedEvidenceCount ?? extendedEvidenceCount,
    explicitSkipCount,
    explicitSkipRate:
      input.explicitSkipRate ??
      (extendedEvidenceCount > 0 ? explicitSkipCount / extendedEvidenceCount : null),
    inferredSkipCount: input.inferredSkipCount ?? 0,
    pendingInferredSkipCount: input.pendingInferredSkipCount ?? 0,
    cooldownLastPlayedAt:
      input.cooldownLastPlayedAt ?? input.lastPlayedAt ?? new Date("2026-01-01T00:00:00.000Z"),
    cooldownLastPlayedSource: input.cooldownLastPlayedSource ?? "TIMELINE",
    cooldownEligible: input.cooldownEligible ?? true,
  };
}

test("real-data calibration favors sustained affinity over short high-skip activity", () => {
  const fuel = scoreArtistProfile(
    artist({
      artistName: "Fuel",
      playCount: 130,
      priorPlayCount: 127,
      plays30d: 3,
      plays90d: 4,
      distinctTrackCount: 43,
      distinctListeningDays: 104,
      listeningDays30d: 3,
      extendedEvidenceCount: 112,
      explicitSkipCount: 9,
      explicitSkipRate: 9 / 112,
      momentumDelta30d: 3,
      momentumListeningDayDelta30d: 3,
    }),
  );
  const helvegen = scoreArtistProfile(
    artist({
      artistName: "Helvegen",
      playCount: 14,
      priorPlayCount: 8,
      plays30d: 6,
      plays90d: 6,
      distinctTrackCount: 5,
      distinctListeningDays: 11,
      listeningDays30d: 3,
      extendedEvidenceCount: 13,
      explicitSkipCount: 11,
      explicitSkipRate: 11 / 13,
      momentumDelta30d: 6,
      momentumListeningDayDelta30d: 3,
    }),
  );
  const incubus = scoreArtistProfile(
    artist({
      artistName: "Incubus",
      playCount: 451,
      priorPlayCount: 420,
      plays30d: 31,
      plays90d: 33,
      distinctTrackCount: 165,
      distinctListeningDays: 250,
      listeningDays30d: 8,
      extendedEvidenceCount: 301,
      explicitSkipCount: 64,
      explicitSkipRate: 64 / 301,
      momentumDelta30d: 31,
      momentumListeningDayDelta30d: 8,
    }),
  );
  const alabama = scoreArtistProfile(
    artist({
      artistName: "Alabama Shakes",
      playCount: 27,
      priorPlayCount: 0,
      plays30d: 27,
      plays90d: 27,
      distinctTrackCount: 24,
      distinctListeningDays: 2,
      listeningDays30d: 2,
      extendedEvidenceCount: 9,
      explicitSkipCount: 8,
      explicitSkipRate: 8 / 9,
      momentumDelta30d: 27,
      momentumListeningDayDelta30d: 2,
    }),
  );

  assert.ok(fuel.score > helvegen.score);
  assert.ok(incubus.score > alabama.score);
  assert.equal(alabama.components.momentum, 0);
  assert.ok(
    helvegen.reasons.some((reason) => reason.code === "HIGH_EXPLICIT_SKIP_RATE"),
  );
});

test("FAMILIAR rewards durable low-skip tracks and a single inferred skip does not ban", () => {
  const mudvayne = artist({
    artistName: "Mudvayne",
    playCount: 500,
    distinctListeningDays: 280,
    distinctTrackCount: 120,
    extendedEvidenceCount: 400,
    explicitSkipCount: 35,
    explicitSkipRate: 35 / 400,
  });
  const report = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [mudvayne],
    tracks: [
      track({
        spotifyTrackId: "happy",
        trackName: "Happy?",
        artistName: "Mudvayne",
        playCount: 108,
        distinctListeningDays: 97,
        extendedEvidenceCount: 108,
        explicitSkipCount: 4,
        explicitSkipRate: 4 / 108,
        inferredSkipCount: 1,
      }),
      track({
        spotifyTrackId: "noisy",
        trackName: "Noisy",
        artistName: "Mudvayne",
        playCount: 40,
        distinctListeningDays: 30,
        extendedEvidenceCount: 20,
        explicitSkipCount: 17,
        explicitSkipRate: 17 / 20,
      }),
    ],
  });

  assert.equal(report.familiarCandidates[0]?.spotifyTrackId, "happy");
  assert.ok((report.familiarCandidates[0]?.score ?? 0) > 0);
  assert.ok(
    report.familiarCandidates[0]?.reasons.some(
      (reason) => reason.code === "INFERRED_SKIP_SIGNAL",
    ),
  );
});

test("cooldown remains an eligibility gate for FAMILIAR", () => {
  const report = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [artist({ artistName: "System Of A Down", playCount: 1000, distinctListeningDays: 470 })],
    tracks: [
      track({
        spotifyTrackId: "chop-suey",
        trackName: "Chop Suey!",
        artistName: "System Of A Down",
        playCount: 58,
        distinctListeningDays: 49,
        cooldownEligible: false,
        lastPlayedAt: new Date("2026-08-16T17:46:27.584Z"),
      }),
    ],
  });

  assert.equal(report.familiarCandidates.length, 0);
});

test("REDISCOVERY_RETURN requires historical depth and rejects huge-gap one-offs", () => {
  const trapt = artist({
    artistName: "Trapt",
    playCount: 229,
    priorPlayCount: 226,
    plays30d: 3,
    distinctListeningDays: 165,
    listeningDays30d: 2,
    rediscoveryGapDays: 353,
    extendedEvidenceCount: 188,
    explicitSkipCount: 16,
    explicitSkipRate: 16 / 188,
  });
  const altJLike = artist({
    artistName: "alt-J-like",
    playCount: 3,
    priorPlayCount: 2,
    plays30d: 1,
    distinctListeningDays: 3,
    listeningDays30d: 1,
    rediscoveryGapDays: 4324,
    extendedEvidenceCount: 2,
    explicitSkipCount: 2,
    explicitSkipRate: 1,
  });

  const report = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [trapt, altJLike],
    tracks: [],
  });

  assert.deepEqual(report.rediscoveryReturns.map((candidate) => candidate.artistName), ["Trapt"]);
  assert.ok(
    report.rediscoveryReturns[0]?.reasons.some(
      (reason) => reason.code === "REDISCOVERY_RETURN",
    ),
  );
});

test("DESCOBERTA preserves provenance and never calls known history new", () => {
  const fresh = scoreExternalDiscoveryCandidate({
    candidateKey: "fresh-artist",
    artistName: "Fresh Artist",
    source: "LASTFM_SIMILAR_ARTIST",
    similarity: 0.9,
    seedArtistAffinity: 0.82,
    sourceConfidence: 0.9,
    knownHistoricalPlayCount: 0,
  });
  const known = scoreExternalDiscoveryCandidate({
    candidateKey: "known-artist",
    artistName: "Known Artist",
    source: "LASTFM_SIMILAR_ARTIST",
    similarity: 0.95,
    seedArtistAffinity: 0.9,
    knownHistoricalPlayCount: 12,
  });

  assert.equal(fresh.eligible, true);
  assert.equal(fresh.source, "LASTFM_SIMILAR_ARTIST");
  assert.ok(fresh.score > 70);
  assert.equal(known.eligible, false);
  assert.equal(known.score, 0);
  assert.ok(known.reasons.some((reason) => reason.code === "KNOWN_HISTORY_NOT_NEW"));
});

test("Gate 2 scoring is deterministic for identical facts", () => {
  const input = {
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [artist({ artistName: "Fuel", playCount: 130, distinctListeningDays: 104 })],
    tracks: [track({ spotifyTrackId: "fuel-track", trackName: "Track", artistName: "Fuel" })],
  };

  assert.deepEqual(
    buildDiscoveryScoringReport(input),
    buildDiscoveryScoringReport(input),
  );
});
