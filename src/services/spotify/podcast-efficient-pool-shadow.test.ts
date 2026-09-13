import assert from "node:assert/strict";
import test from "node:test";

import type { PodcastShowOverrideShadow } from "./podcast-effective-policy-shadow";
import {
  collectPodcast07EfficientPoolShadow,
  type Podcast07PoolShadowPage,
} from "./podcast-efficient-pool-shadow";
import type { PodcastSavedEpisodesPolicySnapshot } from "./podcast-saved-episodes-policy-store";
import type { PodcastShowPolicyStoredSnapshot } from "./podcast-show-policy-store";

function savedPolicy(
  overrides: Partial<PodcastSavedEpisodesPolicySnapshot> = {},
): PodcastSavedEpisodesPolicySnapshot {
  return {
    sourcePlaylistId: "saved-source",
    enabled: true,
    episodeOrder: "RANDOM",
    randomPolicy: "WITHOUT_REPLACEMENT",
    cadenceMaxEpisodes: 1,
    cadenceUnit: "WEEK",
    frequencyScope: "PER_SHOW",
    ...overrides,
  };
}

function showPolicy(
  sourcePlaylistId: string,
  showEpisodeScope: "ALL_EPISODES" | "SAVED_ONLY",
): PodcastShowPolicyStoredSnapshot {
  return {
    sourcePlaylistId,
    episodeEligibility: "UNPLAYED_ONLY",
    episodeOrder: "OLDEST_FIRST",
    randomPolicy: "WITHOUT_REPLACEMENT",
    showEpisodeScope,
    startEpisodeId: null,
    strictSequence: true,
    maxReleaseAgeDays: null,
    expiryPolicy: "STRICT_EXPIRY",
    maxEpisodesPerCycle: null,
    randomRound: 0,
    cadenceMaxEpisodes: null,
    cadenceUnit: null,
    priority: "NORMAL",
  };
}

function override(input: {
  spotifyShowId: string;
  sourcePlaylistId: string;
  scope: "ALL_EPISODES" | "SAVED_ONLY";
}): PodcastShowOverrideShadow {
  return {
    spotifyShowId: input.spotifyShowId,
    sourcePlaylistId: input.sourcePlaylistId,
    showName: `Configured ${input.spotifyShowId}`,
    showEpisodeScope: input.scope,
    policy: showPolicy(input.sourcePlaylistId, input.scope),
  };
}

function episode(
  spotifyEpisodeId: string,
  spotifyShowId: string | null,
  showName: string | null = spotifyShowId,
) {
  return {
    spotifyEpisodeId,
    spotifyUri: `spotify:episode:${spotifyEpisodeId}`,
    spotifyShowId,
    showName,
  };
}

function page(
  episodes: ReturnType<typeof episode>[],
  nextCursor: string | null = null,
): Podcast07PoolShadowPage {
  return { episodes, nextCursor };
}

function provider(input: {
  saved: Record<string, Podcast07PoolShadowPage>;
  shows?: Record<string, Record<string, Podcast07PoolShadowPage>>;
}) {
  const requestedShows: string[] = [];
  return {
    requestedShows,
    adapter: {
      async readSavedEpisodesPage(cursor: string | null) {
        const key = cursor ?? "FIRST";
        const result = input.saved[key];
        if (!result) throw new Error(`Unexpected saved cursor ${key}`);
        return result;
      },
      async readShowEpisodesPage(spotifyShowId: string, cursor: string | null) {
        requestedShows.push(spotifyShowId);
        const key = cursor ?? "FIRST";
        const result = input.shows?.[spotifyShowId]?.[key];
        if (!result) {
          throw new Error(`Unexpected show page ${spotifyShowId}:${key}`);
        }
        return result;
      },
    },
  };
}

test("Gate 3 traverses SAVED_EPISODES once, reuses SAVED_ONLY and reads catalog only for ALL_EPISODES", async () => {
  const fake = provider({
    saved: {
      FIRST: page(
        [
          episode("a-1", "show-a", "Show A"),
          episode("b-1", "show-b", "Show B"),
          episode("c-1", "show-c", "Show C"),
        ],
        "saved-2",
      ),
      "saved-2": page([
        episode("a-2", "show-a", "Show A"),
        episode("d-1", "show-d", "Show D"),
      ]),
    },
    shows: {
      "show-c": {
        FIRST: page([episode("c-1", "show-c", "Show C")], "show-c-2"),
        "show-c-2": page([episode("c-2", "show-c", "Show C")]),
      },
      "show-z": {
        FIRST: page([episode("z-1", null, "Show Z")]),
      },
    },
  });

  const result = await collectPodcast07EfficientPoolShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [
      override({
        spotifyShowId: "show-a",
        sourcePlaylistId: "show-source-a",
        scope: "SAVED_ONLY",
      }),
      override({
        spotifyShowId: "show-c",
        sourcePlaylistId: "show-source-c",
        scope: "ALL_EPISODES",
      }),
      override({
        spotifyShowId: "show-z",
        sourcePlaylistId: "show-source-z",
        scope: "ALL_EPISODES",
      }),
    ],
    provider: fake.adapter,
  });

  assert.equal(result.diagnostics.savedEpisodesTraversalCount, 1);
  assert.equal(result.diagnostics.savedEpisodesCallCount, 2);
  assert.equal(result.diagnostics.savedEpisodesPageCount, 2);
  assert.equal(result.diagnostics.savedEpisodesFetchedCount, 5);
  assert.deepEqual(fake.requestedShows, ["show-c", "show-c", "show-z"]);
  assert.equal(result.diagnostics.showCatalogCallCount, 3);
  assert.equal(result.diagnostics.showCatalogPageCount, 3);
  assert.deepEqual(result.diagnostics.showCatalogCallsByShowId, {
    "show-c": 2,
    "show-z": 1,
  });
  assert.equal(result.diagnostics.savedOnlyReusedCandidateCount, 2);
  assert.equal(result.diagnostics.precedenceSuppressedSavedEpisodeCount, 3);
  assert.equal(result.diagnostics.savedOnlyOverrideShowCount, 1);
  assert.equal(result.diagnostics.allEpisodesOverrideShowCount, 2);
  assert.equal(result.diagnostics.defaultGovernedShowCount, 2);

  assert.deepEqual(
    result.candidates.map((candidate) => [
      candidate.spotifyEpisodeId,
      candidate.authority,
      candidate.sourcePlaylistId,
      candidate.showEpisodeScope,
      candidate.origin,
    ]),
    [
      ["a-1", "SHOW_OVERRIDE", "show-source-a", "SAVED_ONLY", "SAVED_EPISODES"],
      ["a-2", "SHOW_OVERRIDE", "show-source-a", "SAVED_ONLY", "SAVED_EPISODES"],
      ["b-1", "SAVED_EPISODES_DEFAULT", "saved-source", null, "SAVED_EPISODES"],
      ["d-1", "SAVED_EPISODES_DEFAULT", "saved-source", null, "SAVED_EPISODES"],
      ["c-1", "SHOW_OVERRIDE", "show-source-c", "ALL_EPISODES", "SHOW_CATALOG"],
      ["c-2", "SHOW_OVERRIDE", "show-source-c", "ALL_EPISODES", "SHOW_CATALOG"],
      ["z-1", "SHOW_OVERRIDE", "show-source-z", "ALL_EPISODES", "SHOW_CATALOG"],
    ],
  );
  assert.equal(result.diagnostics.resolvedCandidateCount, 7);
  assert.equal(result.diagnostics.deduplicatedCandidateCount, 0);
});

test("Gate 3 SAVED_ONLY never opens a show catalog even when it has no saved episode", async () => {
  const fake = provider({
    saved: {
      FIRST: page([episode("b-1", "show-b", "Show B")]),
    },
  });

  const result = await collectPodcast07EfficientPoolShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [
      override({
        spotifyShowId: "show-a",
        sourcePlaylistId: "show-source-a",
        scope: "SAVED_ONLY",
      }),
    ],
    provider: fake.adapter,
  });

  assert.deepEqual(fake.requestedShows, []);
  assert.equal(result.diagnostics.showCatalogCallCount, 0);
  assert.equal(result.diagnostics.savedOnlyReusedCandidateCount, 0);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.spotifyEpisodeId),
    ["b-1"],
  );
});

test("Gate 3 keeps legacy SAVED_EPISODES semantics when the default policy is disabled", async () => {
  const fake = provider({
    saved: {
      FIRST: page([
        episode("a-1", "show-a", "Show A"),
        episode("b-1", "show-b", "Show B"),
      ]),
    },
  });

  const result = await collectPodcast07EfficientPoolShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy({ enabled: false }),
    showOverrides: [
      override({
        spotifyShowId: "show-a",
        sourcePlaylistId: "show-source-a",
        scope: "SAVED_ONLY",
      }),
    ],
    provider: fake.adapter,
  });

  assert.equal(result.diagnostics.legacySavedEpisodesShowCount, 1);
  assert.deepEqual(
    result.candidates.map((candidate) => [
      candidate.spotifyEpisodeId,
      candidate.authority,
      candidate.sourcePlaylistId,
    ]),
    [
      ["a-1", "SHOW_OVERRIDE", "show-source-a"],
      ["b-1", "LEGACY_SAVED_EPISODES", "saved-source"],
    ],
  );
});

test("Gate 3 canonical authority is independent from override input order", async () => {
  const low = override({
    spotifyShowId: "show-a",
    sourcePlaylistId: "show-source-a-1",
    scope: "SAVED_ONLY",
  });
  const high = override({
    spotifyShowId: "show-a",
    sourcePlaylistId: "show-source-a-2",
    scope: "SAVED_ONLY",
  });

  async function run(showOverrides: PodcastShowOverrideShadow[]) {
    const fake = provider({
      saved: { FIRST: page([episode("a-1", "show-a", "Show A")]) },
    });
    return collectPodcast07EfficientPoolShadow({
      savedEpisodesSourcePlaylistId: "saved-source",
      defaultPolicy: savedPolicy(),
      showOverrides,
      provider: fake.adapter,
    });
  }

  const first = await run([low, high]);
  const second = await run([high, low]);

  assert.deepEqual(first.candidates, second.candidates);
  assert.equal(first.candidates[0]?.sourcePlaylistId, "show-source-a-2");
});

test("Gate 3 dedupes repeated provider identity after authority resolution", async () => {
  const fake = provider({
    saved: {
      FIRST: page([
        episode("b-1", "show-b", "Show B"),
        episode("b-1", "show-b", "Show B"),
      ]),
    },
  });

  const result = await collectPodcast07EfficientPoolShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [],
    provider: fake.adapter,
  });

  assert.equal(result.diagnostics.deduplicatedCandidateCount, 1);
  assert.equal(result.diagnostics.resolvedCandidateCount, 1);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.spotifyEpisodeId),
    ["b-1"],
  );
});

test("Gate 3 fails closed on a catalog episode that belongs to another show", async () => {
  const fake = provider({
    saved: { FIRST: page([]) },
    shows: {
      "show-a": {
        FIRST: page([
          episode("a-1", "show-a", "Show A"),
          episode("wrong-1", "show-wrong", "Wrong Show"),
        ]),
      },
    },
  });

  const result = await collectPodcast07EfficientPoolShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [
      override({
        spotifyShowId: "show-a",
        sourcePlaylistId: "show-source-a",
        scope: "ALL_EPISODES",
      }),
    ],
    provider: fake.adapter,
  });

  assert.equal(result.diagnostics.catalogShowMismatchCount, 1);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.spotifyEpisodeId),
    ["a-1"],
  );
});

test("Gate 3 aborts repeated pagination cursors instead of looping", async () => {
  const fake = provider({
    saved: {
      FIRST: page([], "repeat"),
      repeat: page([], "repeat"),
    },
  });

  await assert.rejects(
    collectPodcast07EfficientPoolShadow({
      savedEpisodesSourcePlaylistId: "saved-source",
      defaultPolicy: savedPolicy(),
      showOverrides: [],
      provider: fake.adapter,
    }),
    /repeated cursor/,
  );
});
