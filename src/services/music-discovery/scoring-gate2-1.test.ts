import assert from "node:assert/strict";
import test from "node:test";

import type {
  DiscoveryArtistProfile,
  DiscoveryTrackProfile,
} from "./profile";
import {
  assertDiscoverySelectionReady,
  buildDiscoveryScoringReport,
  scoreArtistProfile,
} from "./scoring";

const AS_OF = new Date("2026-08-20T18:00:00.000Z");

function artist(
  input: Partial<DiscoveryArtistProfile> & Pick<DiscoveryArtistProfile, "artistName">,
): DiscoveryArtistProfile {
  const extendedEvidenceCount = input.extendedEvidenceCount ?? 80;
  const explicitSkipCount = input.explicitSkipCount ?? 5;
  return {
    artistName: input.artistName,
    playCount: input.playCount ?? 200,
    priorPlayCount: input.priorPlayCount ?? 195,
    plays30d: input.plays30d ?? 5,
    previous30d: input.previous30d ?? 0,
    plays90d: input.plays90d ?? input.plays30d ?? 5,
    plays365d: input.plays365d ?? input.plays90d ?? input.plays30d ?? 5,
    distinctTrackCount: input.distinctTrackCount ?? 70,
    distinctListeningDays: input.distinctListeningDays ?? 120,
    listeningDays30d: input.listeningDays30d ?? 4,
    previousListeningDays30d: input.previousListeningDays30d ?? 0,
    firstPlayedAt: input.firstPlayedAt ?? new Date("2015-01-01T00:00:00.000Z"),
    lastPlayedAt: input.lastPlayedAt ?? new Date("2026-08-10T00:00:00.000Z"),
    extendedEvidenceCount,
    msPlayedEvidenceCount: input.msPlayedEvidenceCount ?? extendedEvidenceCount,
    explicitSkipCount,
    explicitSkipRate:
      input.explicitSkipRate ??
      (extendedEvidenceCount > 0 ? explicitSkipCount / extendedEvidenceCount : null),
    inferredSkipCount: input.inferredSkipCount ?? 0,
    pendingInferredSkipCount: input.pendingInferredSkipCount ?? 0,
    momentumDelta30d: input.momentumDelta30d ?? 5,
    momentumListeningDayDelta30d: input.momentumListeningDayDelta30d ?? 4,
    momentumRatio30d: input.momentumRatio30d ?? null,
    daysSinceLastPlay: input.daysSinceLastPlay ?? 10,
    rediscoveryGapDays: input.rediscoveryGapDays ?? null,
  };
}

function track(
  input: Partial<DiscoveryTrackProfile> &
    Pick<DiscoveryTrackProfile, "spotifyTrackId" | "trackName" | "artistName">,
): DiscoveryTrackProfile {
  const extendedEvidenceCount = input.extendedEvidenceCount ?? 50;
  const explicitSkipCount = input.explicitSkipCount ?? 2;
  const lastPlayedAt = input.lastPlayedAt ?? new Date("2026-01-01T00:00:00.000Z");
  return {
    spotifyTrackId: input.spotifyTrackId,
    spotifyUri: input.spotifyUri ?? `spotify:track:${input.spotifyTrackId}`,
    trackName: input.trackName,
    artistName: input.artistName,
    albumName: input.albumName ?? "Album",
    playCount: input.playCount ?? 50,
    plays30d: input.plays30d ?? 0,
    firstPlayedAt: input.firstPlayedAt ?? new Date("2015-01-01T00:00:00.000Z"),
    lastPlayedAt,
    distinctListeningDays: input.distinctListeningDays ?? 40,
    extendedEvidenceCount,
    msPlayedEvidenceCount: input.msPlayedEvidenceCount ?? extendedEvidenceCount,
    explicitSkipCount,
    explicitSkipRate:
      input.explicitSkipRate ??
      (extendedEvidenceCount > 0 ? explicitSkipCount / extendedEvidenceCount : null),
    inferredSkipCount: input.inferredSkipCount ?? 0,
    pendingInferredSkipCount: input.pendingInferredSkipCount ?? 0,
    cooldownLastPlayedAt: input.cooldownLastPlayedAt ?? lastPlayedAt,
    cooldownLastPlayedSource: input.cooldownLastPlayedSource ?? "TIMELINE",
    cooldownEligible: input.cooldownEligible ?? true,
  };
}

test("REDESCOBERTA preempts the same eligible track from FAMILIAR", () => {
  const devildriver = artist({ artistName: "DevilDriver", playCount: 553, distinctListeningDays: 317 });
  const clouds = track({
    spotifyTrackId: "clouds",
    trackName: "Clouds Over California",
    artistName: "DevilDriver",
    playCount: 64,
    distinctListeningDays: 58,
    lastPlayedAt: new Date("2023-06-02T00:00:00.000Z"),
    extendedEvidenceCount: 60,
    explicitSkipCount: 1,
  });

  const report = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 20,
    artists: [devildriver],
    tracks: [clouds],
    candidateUniverse: "COMPLETE",
  });

  assert.deepEqual(report.rediscoveryCandidates.map((row) => row.spotifyTrackId), ["clouds"]);
  assert.equal(report.familiarCandidates.length, 0);
  assert.equal(report.selectionPolicy.rediscoveryPreemptedFamiliarCount, 1);
});

test("returned candidates are explainable and elevated skip penalty is explicit", () => {
  const incubus = artist({ artistName: "Incubus", playCount: 451, distinctListeningDays: 250 });
  const row = track({
    spotifyTrackId: "wish",
    trackName: "Wish You Were Here",
    artistName: "Incubus",
    playCount: 42,
    distinctListeningDays: 35,
    extendedEvidenceCount: 50,
    explicitSkipCount: 10,
    explicitSkipRate: 0.2,
  });

  const report = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 20,
    artists: [incubus],
    tracks: [row],
  });

  const familiar = report.familiarCandidates[0];
  assert.ok(familiar);
  assert.ok(familiar.reasons.length > 0);
  assert.ok(
    familiar.reasons.some((reason) => reason.code === "ELEVATED_EXPLICIT_SKIP_RATE"),
  );
  assert.ok(
    familiar.reasons.some(
      (reason) =>
        reason.code === "TRACK_HISTORY_SUPPORT" ||
        reason.code === "HIGH_HISTORICAL_AFFINITY",
    ),
  );
});

test("category score floor allows REDISCOVERY_RETURN to abstain from weak tail", () => {
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
  const stuckMojo = artist({
    artistName: "Stuck Mojo",
    playCount: 50,
    priorPlayCount: 48,
    plays30d: 2,
    distinctListeningDays: 35,
    listeningDays30d: 2,
    distinctTrackCount: 21,
    rediscoveryGapDays: 560,
    extendedEvidenceCount: 34,
    explicitSkipCount: 0,
    explicitSkipRate: 0,
  });

  const report = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 20,
    artists: [trapt, stuckMojo],
    tracks: [],
  });

  assert.deepEqual(report.rediscoveryReturns.map((row) => row.artistName), ["Trapt"]);
  assert.equal(report.selectionPolicy.categoryBudgetRule, "CEILING_NOT_QUOTA");
});

test("zero Extended evidence does not create a prior-only negative penalty", () => {
  const unknown = scoreArtistProfile(
    artist({
      artistName: "Unknown Evidence",
      extendedEvidenceCount: 0,
      msPlayedEvidenceCount: 0,
      explicitSkipCount: 0,
      explicitSkipRate: null,
    }),
  );

  assert.equal(unknown.components.negativePenalty, 0);
  assert.equal(
    unknown.reasons.some(
      (reason) =>
        reason.code === "ELEVATED_EXPLICIT_SKIP_RATE" ||
        reason.code === "HIGH_EXPLICIT_SKIP_RATE",
    ),
    false,
  );
});

test("diagnostic partial pools cannot be used as planner-ready selection", () => {
  const partial = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [artist({ artistName: "Incubus" })],
    tracks: [],
    candidateUniverse: "DIAGNOSTIC_PARTIAL",
  });
  assert.equal(partial.selectionPolicy.selectionReady, false);
  assert.throws(() => assertDiscoverySelectionReady(partial), /candidateUniverse=COMPLETE/);

  const complete = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [artist({ artistName: "Incubus" })],
    tracks: [],
    candidateUniverse: "COMPLETE",
  });
  assert.equal(complete.selectionPolicy.selectionReady, true);
  assert.doesNotThrow(() => assertDiscoverySelectionReady(complete));
});

test("APROFUNDAMENTO has a distinct album reason without duplicate catalog reason", () => {
  const report = buildDiscoveryScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [artist({ artistName: "Incubus", playCount: 451, distinctTrackCount: 165 })],
    tracks: [],
  });

  const deepening = report.deepeningCandidates[0];
  assert.ok(deepening);
  assert.equal(
    deepening.reasons.filter((reason) => reason.code === "CATALOG_BREADTH").length,
    1,
  );
  assert.ok(
    deepening.reasons.some((reason) => reason.code === "ALBUM_DEEPENING_SIGNAL"),
  );
});
