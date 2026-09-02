import assert from "node:assert/strict";
import test from "node:test";

import { LikedTrackAvailability } from "@prisma/client";

import { spotifyRecentlyPlayedPlannerCapability } from "@/services/data-policy";
import { planRun, type Candidate, type RunTarget } from "@/services/playlist-planner";

import {
  applyLikedTrackSourceShadowForCurrentRun,
  buildLikedTrackShadowCandidates,
  resolveLikedTrackSourceShadowPolicy,
} from "./liked-track-source-shadow";
import {
  runWithMusicRepeatState,
  type MusicRepeatRunState,
} from "./music-repeat-runtime";

type ShadowTargetInputEvidence = {
  negativeSignalBlocked?: number;
};

type ShadowTargetEvidence = {
  likedSourceCandidatesSelected?: number;
  shadow?: {
    totalDurationMs?: number;
  };
};

type ShadowTestSummary = {
  status?: string;
  currentPlanUnchanged?: boolean;
  plannerInfluence?: boolean;
  likedSourceCandidatesSelected?: number;
  targetInputs?: ShadowTargetInputEvidence[];
  targets?: ShadowTargetEvidence[];
};

test("legacy shadow rollout policy is still fail-closed operationally", () => {
  assert.equal(
    resolveLikedTrackSourceShadowPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "false",
      allowlistedEmails: "pilot@example.com",
      allowlistedTargetIds: "target-1",
    }).reason,
    "MASTER_DISABLED",
  );
  assert.equal(
    resolveLikedTrackSourceShadowPolicy({
      userEmail: "other@example.com",
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
      allowlistedTargetIds: "target-1",
    }).reason,
    "USER_NOT_ALLOWLISTED",
  );
  const enabled = resolveLikedTrackSourceShadowPolicy({
    userEmail: "PILOT@example.com",
    masterEnabled: "true",
    allowlistedEmails: "pilot@example.com",
    allowlistedTargetIds: "target-1",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.reason, "ENABLED");
  assert.deepEqual([...enabled.targetIds], ["target-1"]);
});

test("native liked candidate materialization includes only available rows with complete planner identity", () => {
  const rows = [
    row("ready", LikedTrackAvailability.AVAILABLE, 180_000),
    row("unavailable", LikedTrackAvailability.UNAVAILABLE, 190_000),
    row("no-duration", LikedTrackAvailability.AVAILABLE, null),
    {
      ...row("no-uri", LikedTrackAvailability.AVAILABLE, 200_000),
      spotifyUri: null,
    },
  ];
  const candidates = buildLikedTrackShadowCandidates(rows);
  assert.deepEqual(
    candidates.map((candidate) => candidate.spotifyTrackId),
    ["ready"],
  );
  assert.equal(candidates[0]?.durationMs, 180_000);
  assert.equal(candidates[0]?.primaryArtistId, "artist-ready");
});

test("legacy pure shadow comparison remains diagnostic and does not mutate the authoritative plan", async () => {
  const target = targetRule("target-1", 300_000);
  const currentCandidate = candidate("current", 200_000);
  const likedCandidate = candidate("liked", 100_000);
  const pools = { music: [currentCandidate], podcasts: [] as Candidate[] };
  const currentPlan = planRun({ pools, targets: [target] });
  const beforeUris = currentPlan.targets[0]!.result.items.map((item) => item.uri);
  const state = runState();

  await runWithMusicRepeatState(state, async () => {
    applyLikedTrackSourceShadowForCurrentRun(
      {
        enabled: true,
        targetIds: new Set(["target-1"]),
        candidates: [likedCandidate],
      },
      {
        pools,
        plan: currentPlan,
        targets: [target],
      },
    );
  });

  assert.deepEqual(
    currentPlan.targets[0]!.result.items.map((item) => item.uri),
    beforeUris,
  );
  const summary = shadowSummary(state);
  assert.equal(summary.status, "READY");
  assert.equal(summary.currentPlanUnchanged, true);
  assert.equal(summary.plannerInfluence, false);
  assert.equal(summary.likedSourceCandidatesSelected, 1);
  assert.equal(summary.targets?.[0]?.likedSourceCandidatesSelected, 1);
  assert.equal(summary.targets?.[0]?.shadow?.totalDurationMs, 300_000);
});

test("legacy pure shadow still honors supplied negative-signal seams", async () => {
  const target = targetRule("target-1", 300_000);
  const currentCandidate = candidate("current", 200_000);
  const likedCandidate = candidate("liked", 100_000);
  const pools = { music: [currentCandidate], podcasts: [] as Candidate[] };
  const currentPlan = planRun({ pools, targets: [target] });
  const state = runState();

  await runWithMusicRepeatState(state, async () => {
    applyLikedTrackSourceShadowForCurrentRun(
      {
        enabled: true,
        targetIds: new Set(["target-1"]),
        candidates: [likedCandidate],
      },
      {
        pools,
        plan: currentPlan,
        targets: [target],
        blockedMusicTrackIdsByTargetId: new Map([
          ["target-1", new Set(["liked"])],
        ]),
      },
    );
  });

  const summary = shadowSummary(state);
  assert.equal(summary.targetInputs?.[0]?.negativeSignalBlocked, 1);
  assert.equal(summary.targets?.[0]?.likedSourceCandidatesSelected, 0);
});

function shadowSummary(state: MusicRepeatRunState): ShadowTestSummary {
  const value = state.likedTrackSourceShadow;
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as ShadowTestSummary;
}

function row(
  id: string,
  availability: LikedTrackAvailability,
  durationMs: number | null,
) {
  return {
    spotifyTrackId: id,
    spotifyUri: `spotify:track:${id}`,
    trackName: `Track ${id}`,
    primaryArtistId: `artist-${id}`,
    primaryArtistName: `Artist ${id}`,
    albumId: `album-${id}`,
    albumName: `Album ${id}`,
    durationMs,
    availability,
  };
}

function candidate(id: string, durationMs: number): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: `Track ${id}`,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    primaryArtistName: `Artist ${id}`,
    albumId: `album-${id}`,
    albumName: `Album ${id}`,
    durationMs,
  };
}

function targetRule(id: string, targetDurationMs: number): RunTarget {
  return {
    targetPlaylistId: id,
    name: id,
    priority: 0,
    rules: {
      targetDurationMs,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
      maxEpisodesPerProgram: 1,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

function runState(): MusicRepeatRunState {
  return {
    userId: "user-1",
    simulate: true,
    context: {
      enabled: false,
      windowValue: null,
      windowUnit: null,
      cutoff: null,
      historyKnownSince: null,
      lastSyncAt: null,
      blockedTrackIds: new Set(),
    },
    initialSync: {
      enabled: false,
      eventsRead: 0,
      identitiesUpdated: 0,
      listeningEventsInserted: 0,
      listeningEventsDuplicateCount: 0,
      listeningEventsSuppressedByHandoff: 0,
      historyKnownSince: null,
      lastSyncAt: null,
    },
    repeatCompliance: spotifyRecentlyPlayedPlannerCapability(),
    recentlyPlayedSkippedCount: 0,
    missingTrackIdentitySkippedCount: 0,
    preWriteSync: null,
    preWriteRevalidated: false,
    preWriteBlockedCount: 0,
    preWriteMissingIdentityCount: 0,
    firstPartyPlaybackPreferences: [],
    firstPartyPreferenceEvidence: null,
    likedTrackSourceShadow: null,
  };
}
