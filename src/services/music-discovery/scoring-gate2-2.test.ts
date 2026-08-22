import assert from "node:assert/strict";
import test from "node:test";

import type {
  DiscoveryArtistProfile,
  DiscoveryTrackProfile,
} from "./profile";
import {
  buildDiscoveryGate22ScoringReport,
  recordingIdentityMatchSource,
} from "./scoring-gate2-2";
import {
  buildDiscoveryTrackIdentityEvidence,
  type DiscoveryTrackIdentityEvidence,
} from "./track-identity";

const AS_OF = new Date("2026-08-20T18:00:00.000Z");

function artist(
  input: Partial<DiscoveryArtistProfile> & Pick<DiscoveryArtistProfile, "artistName">,
): DiscoveryArtistProfile {
  const extendedEvidenceCount = input.extendedEvidenceCount ?? 200;
  const explicitSkipCount = input.explicitSkipCount ?? 10;
  return {
    artistName: input.artistName,
    playCount: input.playCount ?? 500,
    priorPlayCount: input.priorPlayCount ?? 495,
    plays30d: input.plays30d ?? 5,
    previous30d: input.previous30d ?? 0,
    plays90d: input.plays90d ?? 8,
    plays365d: input.plays365d ?? 15,
    distinctTrackCount: input.distinctTrackCount ?? 120,
    distinctListeningDays: input.distinctListeningDays ?? 250,
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
  const extendedEvidenceCount = input.extendedEvidenceCount ?? 60;
  const explicitSkipCount = input.explicitSkipCount ?? 1;
  const lastPlayedAt = input.lastPlayedAt ?? new Date("2026-01-01T00:00:00.000Z");
  return {
    spotifyTrackId: input.spotifyTrackId,
    spotifyUri: input.spotifyUri ?? `spotify:track:${input.spotifyTrackId}`,
    trackName: input.trackName,
    artistName: input.artistName,
    albumName: input.albumName ?? "Album",
    playCount: input.playCount ?? 60,
    plays30d: input.plays30d ?? 0,
    firstPlayedAt: input.firstPlayedAt ?? new Date("2015-01-01T00:00:00.000Z"),
    lastPlayedAt,
    distinctListeningDays: input.distinctListeningDays ?? 50,
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

function identity(
  spotifyTrackId: string,
  input: Partial<DiscoveryTrackIdentityEvidence> = {},
): DiscoveryTrackIdentityEvidence {
  return {
    spotifyTrackId,
    isrc: input.isrc?.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ?? null,
    primaryArtistId: input.primaryArtistId ?? "artist-1",
    isrcConflict: input.isrcConflict ?? false,
    primaryArtistIdConflict: input.primaryArtistIdConflict ?? false,
  };
}

test("same recording across Spotify IDs shares recency before category scoring", () => {
  const tracks = [
    track({
      spotifyTrackId: "recent-release",
      trackName: "Sun Doesn't Rise",
      artistName: "Mushroomhead",
      lastPlayedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
    track({
      spotifyTrackId: "old-release",
      trackName: "Sun Doesn't Rise",
      artistName: "Mushroomhead",
      lastPlayedAt: new Date("2024-01-01T00:00:00.000Z"),
    }),
  ];
  const report = buildDiscoveryGate22ScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 20,
    artists: [artist({ artistName: "Mushroomhead" })],
    tracks,
    trackIdentities: [identity("recent-release"), identity("old-release")],
    candidateUniverse: "COMPLETE",
  });

  assert.deepEqual(report.rediscoveryCandidates, []);
  assert.equal(
    report.familiarCandidates.some((row) => row.spotifyTrackId === "old-release"),
    true,
  );
  assert.equal(report.selectionPolicy.recordingRecencyAdjustedLastPlayedCount, 1);
  assert.equal(
    report.selectionPolicy.recordingRecencyPolicy,
    "MAX_EQUIVALENT_LAST_PLAYED_AND_COOLDOWN",
  );
});

test("Clouds Over California regression: recent market/release ID blocks dormant equivalent ID", () => {
  const currentId = "6K4qjwuMpp9AT4uuKw2LLQ";
  const historicalId = "21WIpZXepY9HA7NDwYiNaM";
  const report = buildDiscoveryGate22ScoringReport({
    generatedAt: new Date("2026-08-22T02:24:13.220Z"),
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 20,
    artists: [artist({ artistName: "DevilDriver" })],
    tracks: [
      track({
        spotifyTrackId: currentId,
        trackName: "Clouds over California",
        artistName: "DevilDriver",
        albumName: "The Last Kind Words",
        lastPlayedAt: new Date("2026-08-21T16:40:43.809Z"),
        cooldownLastPlayedAt: new Date("2026-08-21T16:40:43.809Z"),
        cooldownLastPlayedSource: "STATE_AND_TIMELINE",
        cooldownEligible: false,
      }),
      track({
        spotifyTrackId: historicalId,
        trackName: "Clouds Over California",
        artistName: "DevilDriver",
        albumName: "The Last Kind Words",
        lastPlayedAt: new Date("2023-07-02T17:47:19.000Z"),
        cooldownLastPlayedAt: new Date("2023-07-02T17:47:19.000Z"),
        cooldownEligible: true,
      }),
    ],
    trackIdentities: [
      identity(currentId, { primaryArtistId: "79el7mcHYhXYW3Zek21i0L" }),
      identity(historicalId, { primaryArtistId: "79el7mcHYhXYW3Zek21i0L" }),
    ],
    candidateUniverse: "COMPLETE",
  });

  const selectedIds = new Set([
    ...report.rediscoveryCandidates.map((row) => row.spotifyTrackId),
    ...report.familiarCandidates.map((row) => row.spotifyTrackId),
  ]);
  assert.equal(selectedIds.has(currentId), false);
  assert.equal(selectedIds.has(historicalId), false);
  assert.equal(report.selectionPolicy.recordingRecencyAdjustedLastPlayedCount, 1);
  assert.equal(
    report.selectionPolicy.recordingRecencyAdjustedCooldownEligibilityCount,
    1,
  );
});

test("equal ISRC preempts across releases even when labels differ", () => {
  const a = {
    spotifyTrackId: "a",
    trackName: "Song",
    artistName: "Artist",
    evidence: identity("a", { isrc: "US-ABC-12-34567" }),
  };
  const b = {
    spotifyTrackId: "b",
    trackName: "Song (Album Edition)",
    artistName: "Artist",
    evidence: identity("b", { isrc: "USABC1234567" }),
  };

  assert.equal(recordingIdentityMatchSource(a, b), "ISRC");
});

test("different ISRCs are authoritative and do not merge equal labels", () => {
  const a = {
    spotifyTrackId: "a",
    trackName: "Song",
    artistName: "Artist",
    evidence: identity("a", { isrc: "USAAA1111111" }),
  };
  const b = {
    spotifyTrackId: "b",
    trackName: "Song",
    artistName: "Artist",
    evidence: identity("b", { isrc: "USBBB2222222" }),
  };

  assert.equal(recordingIdentityMatchSource(a, b), null);
});

test("version-qualified titles do not use title fallback without ISRC", () => {
  const a = {
    spotifyTrackId: "a",
    trackName: "Song - Live",
    artistName: "Artist",
    evidence: identity("a", { isrc: null }),
  };
  const b = {
    spotifyTrackId: "b",
    trackName: "Song - Live",
    artistName: "Artist",
    evidence: identity("b", { isrc: null }),
  };

  assert.equal(recordingIdentityMatchSource(a, b), null);
});

test("identity evidence refuses conflicting ISRC or primary artist facts", () => {
  const rows = buildDiscoveryTrackIdentityEvidence([
    { spotifyTrackId: "track", isrc: "US-AAA-11-11111", primaryArtistId: "artist-a" },
    { spotifyTrackId: "track", isrc: "USBBB2222222", primaryArtistId: "artist-b" },
  ]);

  assert.deepEqual(rows, [
    {
      spotifyTrackId: "track",
      isrc: null,
      primaryArtistId: null,
      isrcConflict: true,
      primaryArtistIdConflict: true,
    },
  ]);
});

test("skip reasons distinguish mild, elevated and high adjusted rates", () => {
  const report = buildDiscoveryGate22ScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [
      artist({
        artistName: "Mild",
        extendedEvidenceCount: 100,
        explicitSkipCount: 15,
        explicitSkipRate: 0.15,
      }),
      artist({
        artistName: "Elevated",
        extendedEvidenceCount: 100,
        explicitSkipCount: 25,
        explicitSkipRate: 0.25,
      }),
      artist({
        artistName: "High",
        extendedEvidenceCount: 100,
        explicitSkipCount: 80,
        explicitSkipRate: 0.8,
      }),
    ],
    tracks: [],
    trackIdentities: [],
    candidateUniverse: "COMPLETE",
  });
  const byArtist = new Map(
    report.topArtistAffinity.map((row) => [row.artistName, row] as const),
  );

  assert.ok(
    byArtist
      .get("Mild")
      ?.reasons.some((reason) => reason.code === "MILD_EXPLICIT_SKIP_PENALTY"),
  );
  assert.equal(
    byArtist
      .get("Mild")
      ?.reasons.some((reason) => reason.code === "ELEVATED_EXPLICIT_SKIP_RATE"),
    false,
  );
  assert.ok(
    byArtist
      .get("Elevated")
      ?.reasons.some((reason) => reason.code === "ELEVATED_EXPLICIT_SKIP_RATE"),
  );
  assert.ok(
    byArtist
      .get("High")
      ?.reasons.some((reason) => reason.code === "HIGH_EXPLICIT_SKIP_RATE"),
  );
});

test("Gate 2.2 preserves the COMPLETE-universe planner contract", () => {
  const report = buildDiscoveryGate22ScoringReport({
    generatedAt: AS_OF,
    dormantDays: 365,
    rediscoveryGapDays: 180,
    topN: 10,
    artists: [artist({ artistName: "Artist" })],
    tracks: [],
    trackIdentities: [],
    candidateUniverse: "COMPLETE",
  });

  assert.equal(report.version, "gate2.2-v1");
  assert.equal(report.selectionPolicy.selectionReady, true);
  assert.equal(
    report.selectionPolicy.recordingIdentityPolicy,
    "ISRC_THEN_CONSERVATIVE_ARTIST_TITLE",
  );
  assert.equal(
    report.selectionPolicy.recordingRecencyPolicy,
    "MAX_EQUIVALENT_LAST_PLAYED_AND_COOLDOWN",
  );
});
