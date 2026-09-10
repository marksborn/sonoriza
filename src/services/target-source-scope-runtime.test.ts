import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type Candidate } from "./playlist-planner";

const music = (
  uri: string,
  sourcePlaylistId?: string,
): Candidate => ({
  uri,
  type: "MUSIC",
  title: uri,
  durationMs: 180_000,
  sourcePlaylistId,
});

const podcast = (
  uri: string,
  sourcePlaylistId?: string,
): Candidate => ({
  uri,
  type: "PODCAST",
  title: uri,
  durationMs: 600_000,
  programId: uri,
  sourcePlaylistId,
});

const target = {
  targetPlaylistId: "target-a",
  name: "Carro",
  priority: 1,
  rules: {
    targetDurationMs: 1_000_000,
    compositionMode: "PROPORTION" as const,
    podcastPercent: 0,
    sequencePattern: [],
    maxEpisodesPerProgram: 1,
  },
};

test("#204 Gate 3 SELECTED_ONLY blocks music from non-selected configured sources", () => {
  const result = planRun({
    pools: {
      music: [music("spotify:track:a", "source-a"), music("spotify:track:b", "source-b")],
      podcasts: [],
    },
    targets: [target],
    sourceIdsByTargetId: new Map([["target-a", new Set(["source-b"])]]),
  });

  assert.deepEqual(
    result.targets[0]?.result.items.map((item) => item.uri),
    ["spotify:track:b"],
  );
});

test("#204 Gate 3 applies configured source scope to podcasts too", () => {
  const podcastTarget = {
    ...target,
    rules: {
      ...target.rules,
      podcastPercent: 100,
    },
  };

  const result = planRun({
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:a", "source-a"),
        podcast("spotify:episode:b", "source-b"),
      ],
    },
    targets: [podcastTarget],
    sourceIdsByTargetId: new Map([["target-a", new Set(["source-b"])]]),
  });

  assert.deepEqual(
    result.targets[0]?.result.items.map((item) => item.uri),
    ["spotify:episode:b"],
  );
});

test("#204 Gate 3 empty SELECTED_ONLY does not fall back to global configured sources", () => {
  const result = planRun({
    pools: {
      music: [music("spotify:track:a", "source-a")],
      podcasts: [],
    },
    targets: [target],
    sourceIdsByTargetId: new Map([["target-a", new Set()]]),
  });

  assert.equal(result.targets[0]?.result.items.length, 0);
});

test("#204 Gate 3 INHERIT_GLOBAL parity is preserved when all configured sources are effective", () => {
  const pools = {
    music: [
      music("spotify:track:a", "source-a"),
      music("spotify:track:b", "source-b"),
    ],
    podcasts: [],
  };

  const legacy = planRun({ pools, targets: [target] });
  const scoped = planRun({
    pools,
    targets: [target],
    sourceIdsByTargetId: new Map([
      ["target-a", new Set(["source-a", "source-b"])],
    ]),
  });

  assert.deepEqual(
    scoped.targets[0]?.result.items.map((item) => item.uri),
    legacy.targets[0]?.result.items.map((item) => item.uri),
  );
});

test("#204 Gate 3 keeps explicit non-configured discovery candidates outside configured-source filtering", () => {
  const result = planRun({
    pools: {
      music: [
        music("spotify:track:configured", "source-a"),
        music("spotify:track:external"),
      ],
      podcasts: [],
    },
    targets: [target],
    sourceIdsByTargetId: new Map([["target-a", new Set()]]),
  });

  assert.deepEqual(
    result.targets[0]?.result.items.map((item) => item.uri),
    ["spotify:track:external"],
  );
});
