import assert from "node:assert/strict";
import test from "node:test";

import type { PodcastSavedEpisodesPolicySnapshot } from "./podcast-saved-episodes-policy-store";
import {
  resolvePodcastEffectivePolicyShadow,
  type PodcastSavedEpisodeShadowObservation,
  type PodcastShowOverrideShadow,
} from "./podcast-effective-policy-shadow";
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
  showEpisodeScope: "ALL_EPISODES" | "SAVED_ONLY" = "ALL_EPISODES",
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

function episode(
  spotifyEpisodeId: string,
  spotifyShowId: string | null,
  showName: string | null,
): PodcastSavedEpisodeShadowObservation {
  return {
    spotifyEpisodeId,
    spotifyUri: `spotify:episode:${spotifyEpisodeId}`,
    spotifyShowId,
    showName,
  };
}

function override(input: {
  spotifyShowId: string;
  sourcePlaylistId: string;
  scope?: "ALL_EPISODES" | "SAVED_ONLY";
}): PodcastShowOverrideShadow {
  const scope = input.scope ?? "ALL_EPISODES";
  return {
    spotifyShowId: input.spotifyShowId,
    sourcePlaylistId: input.sourcePlaylistId,
    showName: `Configured ${input.spotifyShowId}`,
    showEpisodeScope: scope,
    policy: showPolicy(input.sourcePlaylistId, scope),
  };
}

test("Gate 2 groups SAVED_EPISODES by show and applies the enabled default per show", () => {
  const result = resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [],
    savedEpisodes: [
      episode("a-1", "show-a", "Show A"),
      episode("b-1", "show-b", "Show B"),
      episode("a-2", "show-a", "Show A"),
    ],
  });

  assert.deepEqual(
    result.groups.map((group) => [
      group.spotifyShowId,
      group.savedEpisodeCount,
      group.effectivePolicy.authority,
    ]),
    [
      ["show-a", 2, "SAVED_EPISODES_DEFAULT"],
      ["show-b", 1, "SAVED_EPISODES_DEFAULT"],
    ],
  );
  assert.equal(result.diagnostics.defaultGovernedShowCount, 2);
  assert.equal(result.diagnostics.showOverrideCount, 0);
  assert.equal(result.diagnostics.groupedSavedEpisodeCount, 3);
});

test("Gate 2 explicit SHOW is authoritative and diagnoses generic saved candidates as suppressed", () => {
  const result = resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [
      override({
        spotifyShowId: "show-a",
        sourcePlaylistId: "show-source-a",
        scope: "SAVED_ONLY",
      }),
    ],
    savedEpisodes: [
      episode("a-1", "show-a", "Show A"),
      episode("b-1", "show-b", "Show B"),
      episode("a-2", "show-a", "Show A"),
    ],
  });

  const showA = result.groups.find((group) => group.spotifyShowId === "show-a");
  const showB = result.groups.find((group) => group.spotifyShowId === "show-b");
  assert.equal(showA?.effectivePolicy.authority, "SHOW_OVERRIDE");
  if (showA?.effectivePolicy.authority === "SHOW_OVERRIDE") {
    assert.equal(showA.effectivePolicy.sourcePlaylistId, "show-source-a");
    assert.equal(showA.effectivePolicy.showEpisodeScope, "SAVED_ONLY");
  }
  assert.equal(showB?.effectivePolicy.authority, "SAVED_EPISODES_DEFAULT");
  assert.equal(result.diagnostics.showOverrideCount, 1);
  assert.equal(result.diagnostics.savedOnlyOverrideShowCount, 1);
  assert.equal(result.diagnostics.allEpisodesOverrideShowCount, 0);
  assert.equal(result.diagnostics.shadowSuppressedSavedEpisodeCount, 2);
});

test("Gate 2 keeps ALL_EPISODES SHOW scope visible without fetching or mixing catalogs", () => {
  const result = resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [
      override({
        spotifyShowId: "show-a",
        sourcePlaylistId: "show-source-a",
      }),
    ],
    savedEpisodes: [episode("a-1", "show-a", "Show A")],
  });

  const group = result.groups[0];
  assert.equal(group?.effectivePolicy.authority, "SHOW_OVERRIDE");
  if (group?.effectivePolicy.authority === "SHOW_OVERRIDE") {
    assert.equal(group.effectivePolicy.showEpisodeScope, "ALL_EPISODES");
  }
  assert.equal(result.diagnostics.allEpisodesOverrideShowCount, 1);
  assert.equal(result.diagnostics.savedOnlyOverrideShowCount, 0);
});

test("Gate 2 does not invent a default when SAVED_EPISODES policy is absent or disabled", () => {
  for (const defaultPolicy of [null, savedPolicy({ enabled: false })]) {
    const result = resolvePodcastEffectivePolicyShadow({
      savedEpisodesSourcePlaylistId: "saved-source",
      defaultPolicy,
      showOverrides: [],
      savedEpisodes: [episode("a-1", "show-a", "Show A")],
    });

    assert.equal(
      result.groups[0]?.effectivePolicy.authority,
      "LEGACY_SAVED_EPISODES",
    );
    assert.equal(result.diagnostics.legacySavedEpisodesShowCount, 1);
    assert.equal(result.diagnostics.defaultGovernedShowCount, 0);
  }
});

test("Gate 2 GLOBAL_POOL remains grouped by canonical show id instead of creating a mixed sequence", () => {
  const result = resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy({ frequencyScope: "GLOBAL_POOL" }),
    showOverrides: [],
    savedEpisodes: [
      episode("b-1", "show-b", "Show B"),
      episode("a-1", "show-a", "Show A"),
      episode("b-2", "show-b", "Show B"),
    ],
  });

  assert.deepEqual(
    result.groups.map((group) => [group.spotifyShowId, group.savedEpisodeCount]),
    [
      ["show-a", 1],
      ["show-b", 2],
    ],
  );
  for (const group of result.groups) {
    assert.equal(group.effectivePolicy.authority, "SAVED_EPISODES_DEFAULT");
    if (group.effectivePolicy.authority === "SAVED_EPISODES_DEFAULT") {
      assert.equal(group.effectivePolicy.policy.frequencyScope, "GLOBAL_POOL");
    }
  }
});

test("Gate 2 authority is independent from saved episode and override loading order", () => {
  const episodes = [
    episode("b-1", "show-b", "Show B"),
    episode("a-1", "show-a", "Show A"),
    episode("a-2", "show-a", "Show A"),
  ];
  const overrides = [
    override({ spotifyShowId: "show-b", sourcePlaylistId: "show-source-b" }),
    override({
      spotifyShowId: "show-a",
      sourcePlaylistId: "show-source-a",
      scope: "SAVED_ONLY",
    }),
  ];

  const first = resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: overrides,
    savedEpisodes: episodes,
  });
  const second = resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [...overrides].reverse(),
    savedEpisodes: [...episodes].reverse(),
  });

  assert.deepEqual(
    first.groups.map((group) => [
      group.spotifyShowId,
      group.effectivePolicy.authority,
      group.effectivePolicy.authority === "SHOW_OVERRIDE"
        ? group.effectivePolicy.showEpisodeScope
        : null,
    ]),
    second.groups.map((group) => [
      group.spotifyShowId,
      group.effectivePolicy.authority,
      group.effectivePolicy.authority === "SHOW_OVERRIDE"
        ? group.effectivePolicy.showEpisodeScope
        : null,
    ]),
  );
});

test("Gate 2 counts missing show identity without guessing an authority or mutating observations", () => {
  const observations = [
    episode("unknown-1", null, null),
    episode("a-1", " show-a ", " Show A "),
  ] as const;
  const before = structuredClone(observations);

  const result = resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: savedPolicy(),
    showOverrides: [],
    savedEpisodes: observations,
  });

  assert.equal(result.diagnostics.savedEpisodeCount, 2);
  assert.equal(result.diagnostics.groupedSavedEpisodeCount, 1);
  assert.equal(result.diagnostics.missingShowIdentityCount, 1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.spotifyShowId, "show-a");
  assert.deepEqual(observations, before);
});
