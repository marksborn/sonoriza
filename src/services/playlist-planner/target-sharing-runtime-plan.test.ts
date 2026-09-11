import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type Candidate, type RunTarget } from ".";
import type { TargetSharingReservationOwner } from "./target-sharing-runtime";

const music = (uri: string): Candidate => ({
  uri,
  type: "MUSIC",
  title: uri,
  durationMs: 180_000,
});

const target = (
  id: string,
  priority: number,
): RunTarget => ({
  targetPlaylistId: id,
  name: id,
  priority,
  rules: {
    targetDurationMs: 180_000,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: [],
    maxEpisodesPerProgram: 1,
  },
});

test("#204 Gate 5 runtime allows the same URI for two SHAREABLE targets", () => {
  const result = planRun({
    pools: {
      music: [music("spotify:track:shared")],
      podcasts: [],
    },
    targets: [target("a", 1), target("b", 2)],
    sharingPolicyByTargetId: new Map([
      ["a", "SHAREABLE"],
      ["b", "SHAREABLE"],
    ]),
  });

  assert.deepEqual(
    result.targets.map((entry) =>
      entry.result.items.map((item) => item.uri),
    ),
    [
      ["spotify:track:shared"],
      ["spotify:track:shared"],
    ],
  );

  assert.equal(result.targetSharingRuntime?.mode, "ACTIVE");
  assert.equal(result.targetSharingRuntime?.plannerInfluence, true);
});

test("#204 Gate 5 runtime remains symmetric when either target is EXCLUSIVE", () => {
  for (const policies of [
    new Map([
      ["a", "EXCLUSIVE" as const],
      ["b", "SHAREABLE" as const],
    ]),
    new Map([
      ["a", "SHAREABLE" as const],
      ["b", "EXCLUSIVE" as const],
    ]),
  ]) {
    const result = planRun({
      pools: {
        music: [music("spotify:track:shared")],
        podcasts: [],
      },
      targets: [target("a", 1), target("b", 2)],
      sharingPolicyByTargetId: policies,
    });

    assert.deepEqual(
      result.targets.map((entry) => entry.result.items.length),
      [1, 0],
    );
  }
});

test("#204 Gate 5 external SHAREABLE owner permits partial SHAREABLE run", () => {
  const external = new Map<string, TargetSharingReservationOwner[]>([
    [
      "spotify:track:shared",
      [
        {
          targetPlaylistId: "outside",
          sharingPolicy: "SHAREABLE",
        },
      ],
    ],
  ]);

  const result = planRun({
    pools: {
      music: [music("spotify:track:shared")],
      podcasts: [],
    },
    targets: [target("current", 1)],
    sharingPolicyByTargetId: new Map([
      ["current", "SHAREABLE"],
    ]),
    externalReservationsByUri: external,
  });

  assert.equal(result.targets[0]?.result.items.length, 1);
});

test("#204 Gate 5 external EXCLUSIVE owner blocks partial SHAREABLE run", () => {
  const external = new Map<string, TargetSharingReservationOwner[]>([
    [
      "spotify:track:shared",
      [
        {
          targetPlaylistId: "outside",
          sharingPolicy: "EXCLUSIVE",
        },
      ],
    ],
  ]);

  const result = planRun({
    pools: {
      music: [music("spotify:track:shared")],
      podcasts: [],
    },
    targets: [target("current", 1)],
    sharingPolicyByTargetId: new Map([
      ["current", "SHAREABLE"],
    ]),
    externalReservationsByUri: external,
  });

  assert.equal(result.targets[0]?.result.items.length, 0);
});
