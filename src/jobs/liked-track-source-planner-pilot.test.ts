import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type Candidate, type RunTarget } from "@/services/playlist-planner";

import {
  buildLikedTrackProductivePilotPlan,
  LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY,
  resolveLikedTrackSourcePlannerPilotPolicy,
} from "./liked-track-source-shadow";

test("Gate 5A policy is fail-closed and locks productive exposure at 5%", () => {
  assert.equal(LIKED_TRACK_SOURCE_PLANNER_PILOT_POLICY.exposurePercent, 5);

  assert.deepEqual(
    resolveLikedTrackSourcePlannerPilotPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "false",
      allowlistedEmails: "pilot@example.com",
      allowlistedTargetIds: "target-1",
    }),
    {
      enabled: false,
      reason: "MASTER_DISABLED",
      targetIds: new Set(["target-1"]),
    },
  );

  assert.equal(
    resolveLikedTrackSourcePlannerPilotPolicy({
      userEmail: "other@example.com",
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
      allowlistedTargetIds: "target-1",
    }).reason,
    "USER_NOT_ALLOWLISTED",
  );

  assert.equal(
    resolveLikedTrackSourcePlannerPilotPolicy({
      userEmail: "pilot@example.com",
      masterEnabled: "true",
      allowlistedEmails: "pilot@example.com",
      allowlistedTargetIds: "",
    }).reason,
    "TARGET_ALLOWLIST_EMPTY",
  );
});

test("Gate 5A changes only the allowlisted target and preserves a ready non-allowlisted target", () => {
  const target1 = targetRule("target-1", 1_200_000, 0);
  const target2 = targetRule("target-2", 1_200_000, 1);
  const current1 = Array.from({ length: 30 }, (_, index) =>
    candidate(`a-${index}`, 60_000),
  );
  const current2 = Array.from({ length: 30 }, (_, index) =>
    candidate(`b-${index}`, 60_000),
  );
  const liked = [candidate("liked-new", 60_000)];
  const musicPoolByTargetId = new Map<string, Candidate[]>([
    ["target-1", current1],
    ["target-2", current2],
  ]);
  const pools = { music: [...current1, ...current2], podcasts: [] as Candidate[] };
  const currentPlan = planRun({
    pools,
    targets: [target1, target2],
    musicPoolByTargetId,
  });
  const target2Before = currentPlan.targets
    .find((target) => target.targetPlaylistId === "target-2")!
    .result.items.map((item) => item.uri);

  const proposal = buildLikedTrackProductivePilotPlan({
    candidates: liked,
    targetIds: new Set(["target-1"]),
    context: {
      pools,
      plan: currentPlan,
      targets: [target1, target2],
      musicPoolByTargetId,
    },
  });

  assert.equal(proposal.safe, true);
  assert.equal(proposal.changed, true);
  assert.deepEqual(proposal.guardFailures, []);

  const target1After = proposal.plan.targets.find(
    (target) => target.targetPlaylistId === "target-1",
  )!;
  const target2After = proposal.plan.targets.find(
    (target) => target.targetPlaylistId === "target-2",
  )!;
  assert.equal(
    target1After.result.items.some((item) => item.spotifyTrackId === "liked-new"),
    true,
  );
  assert.deepEqual(
    target2After.result.items.map((item) => item.uri),
    target2Before,
  );

  const targetEvidence = proposal.targets.find(
    (target) => target.targetPlaylistId === "target-1",
  )!;
  assert.equal(targetEvidence.allowlisted, true);
  assert.equal(targetEvidence.exclusiveLikedSelectedCount, 1);
});


test("#332 productive liked replan preserves target source scope", () => {
  const target = targetRule("carro", 1_200_000, 0);

  const current = Array.from(
    { length: 30 },
    (_, index) => candidate(`current-${index}`, 60_000),
  );

  const outsideScopeLiked = {
    ...candidate("liked-outside-scope", 60_000),
    sourcePlaylistId: "source-blocked",
  };

  const pools = {
    music: current,
    podcasts: [] as Candidate[],
  };

  const sourceIdsByTargetId = new Map<string, ReadonlySet<string>>([
    ["carro", new Set(["source-allowed"])],
  ]);

  const currentPlan = planRun({
    pools,
    targets: [target],
    sourceIdsByTargetId,
  });

  const proposal = buildLikedTrackProductivePilotPlan({
    candidates: [outsideScopeLiked],
    targetIds: new Set(["carro"]),
    context: {
      pools,
      plan: currentPlan,
      targets: [target],
      sourceIdsByTargetId,
    },
  });

  assert.equal(proposal.safe, true);

  assert.equal(
    proposal.plan.targets[0]!.result.items.some(
      (item) => item.spotifyTrackId === "liked-outside-scope",
    ),
    false,
  );
});

test("#332 productive liked replan preserves EXCLUSIVE external reservations", () => {
  const target = targetRule("carro", 1_200_000, 0);

  const current = Array.from(
    { length: 30 },
    (_, index) => candidate(`current-${index}`, 60_000),
  );

  const reservedLiked = candidate(
    "liked-reserved-by-trabalho",
    60_000,
  );

  const pools = {
    music: current,
    podcasts: [] as Candidate[],
  };

  const sharingPolicyByTargetId =
    new Map<string, "EXCLUSIVE" | "SHAREABLE">([
      ["carro", "EXCLUSIVE"],
    ]);

  const externalReservationsByUri = new Map([
    [
      reservedLiked.uri,
      [
        {
          targetPlaylistId: "trabalho",
          sharingPolicy: "EXCLUSIVE" as const,
        },
      ],
    ],
  ]);

  const currentPlan = planRun({
    pools,
    targets: [target],
    sharingPolicyByTargetId,
    externalReservationsByUri,
  });

  assert.equal(
    currentPlan.targets[0]!.result.items.some(
      (item) =>
        item.spotifyTrackId ===
        "liked-reserved-by-trabalho",
    ),
    false,
  );

  const proposal = buildLikedTrackProductivePilotPlan({
    candidates: [reservedLiked],
    targetIds: new Set(["carro"]),
    context: {
      pools,
      plan: currentPlan,
      targets: [target],
      sharingPolicyByTargetId,
      externalReservationsByUri,
    },
  });

  assert.equal(proposal.safe, true);

  assert.equal(
    proposal.plan.targets[0]!.result.items.some(
      (item) =>
        item.spotifyTrackId ===
        "liked-reserved-by-trabalho",
    ),
    false,
  );

  assert.equal(
    proposal.guardFailures.some(
      (failure) =>
        failure.reason === "TARGET_SHARING_VIOLATION",
    ),
    false,
  );

  const runtimeTarget =
    proposal.plan.targetSharingRuntime?.targets.find(
      (entry) =>
        entry.targetPlaylistId === "carro",
    );

  assert.equal(
    runtimeTarget?.effectiveSharingPolicy,
    "EXCLUSIVE",
  );

  assert.equal(
    runtimeTarget?.blockedByPolicyCount,
    1,
  );

  assert.deepEqual(
    runtimeTarget?.conflictingTargetIds,
    ["trabalho"],
  );
});

test("Gate 5A removes target-scoped negative liked candidates before productive arbitration", () => {
  const target = targetRule("target-1", 1_200_000, 0);
  const current = Array.from({ length: 30 }, (_, index) =>
    candidate(`current-${index}`, 60_000),
  );
  const blockedLiked = candidate("liked-blocked", 60_000);
  const pools = { music: current, podcasts: [] as Candidate[] };
  const currentPlan = planRun({ pools, targets: [target] });

  const proposal = buildLikedTrackProductivePilotPlan({
    candidates: [blockedLiked],
    targetIds: new Set(["target-1"]),
    context: {
      pools,
      plan: currentPlan,
      targets: [target],
      blockedMusicTrackIdsByTargetId: new Map([
        ["target-1", new Set(["liked-blocked"])],
      ]),
    },
  });

  assert.equal(proposal.safe, true);
  assert.equal(proposal.changed, false);
  const input = proposal.targetInputs[0]!;
  assert.equal(input.exclusiveLikedBeforeNegative, 1);
  assert.equal(input.exclusiveLikedEligible, 0);
  assert.equal(input.negativeSignalBlocked, 1);
  assert.equal(
    proposal.plan.targets[0]!.result.items.some(
      (item) => item.spotifyTrackId === "liked-blocked",
    ),
    false,
  );
});

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

function targetRule(
  id: string,
  targetDurationMs: number,
  priority: number,
): RunTarget {
  return {
    targetPlaylistId: id,
    name: id,
    priority,
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
