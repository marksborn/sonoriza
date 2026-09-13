import assert from "node:assert/strict";
import test from "node:test";

import {
  podcast07ConfigurationFingerprint,
  type Podcast07FingerprintSnapshot,
} from "./podcast-07-generation-configuration";

function snapshot(): Podcast07FingerprintSnapshot {
  return {
    savedEpisodes: [
      {
        sourcePlaylistId: "saved-source",
        spotifyId: "saved",
        enabled: true,
        episodeOrder: "RANDOM",
        randomPolicy: "WITHOUT_REPLACEMENT",
        cadenceMaxEpisodes: 1,
        cadenceUnit: "WEEK",
        frequencyScope: "PER_SHOW",
      },
    ],
    shows: [
      {
        sourcePlaylistId: "show-source",
        spotifyShowId: "show-a",
        authority: "SHOW_OVERRIDE",
        policy: {
          episodeEligibility: "UNPLAYED_ONLY",
          episodeOrder: "OLDEST_FIRST",
          randomPolicy: "WITHOUT_REPLACEMENT",
          showEpisodeScope: "ALL_EPISODES",
          startEpisodeId: null,
          strictSequence: true,
          maxReleaseAgeDays: null,
          expiryPolicy: "STRICT_EXPIRY",
          maxEpisodesPerCycle: null,
          cadenceMaxEpisodes: 1,
          cadenceUnit: "WEEK",
          priority: "NORMAL",
        },
      },
    ],
  };
}

function fingerprint(value: Podcast07FingerprintSnapshot): string {
  return podcast07ConfigurationFingerprint("base-config", value);
}

test("Gate 6 fingerprint is deterministic regardless of snapshot input order", () => {
  const base = snapshot();
  const extraSaved = {
    ...base.savedEpisodes[0]!,
    sourcePlaylistId: "saved-source-b",
    spotifyId: "saved-b",
  };
  const extraShow = {
    ...base.shows[0]!,
    sourcePlaylistId: "show-source-b",
    spotifyShowId: "show-b",
  };
  const left = {
    savedEpisodes: [base.savedEpisodes[0]!, extraSaved],
    shows: [base.shows[0]!, extraShow],
  } satisfies Podcast07FingerprintSnapshot;
  const right = {
    savedEpisodes: [extraSaved, base.savedEpisodes[0]!],
    shows: [extraShow, base.shows[0]!],
  } satisfies Podcast07FingerprintSnapshot;

  assert.equal(fingerprint(left), fingerprint(right));
});

test("Gate 6 invalidates simulation when SAVED_EPISODES plan-affecting policy changes", () => {
  const base = snapshot();
  const original = fingerprint(base);
  const mutations: Podcast07FingerprintSnapshot[] = [
    {
      ...base,
      savedEpisodes: [{ ...base.savedEpisodes[0]!, frequencyScope: "GLOBAL_POOL" }],
    },
    {
      ...base,
      savedEpisodes: [{ ...base.savedEpisodes[0]!, cadenceMaxEpisodes: 2 }],
    },
    {
      ...base,
      savedEpisodes: [{ ...base.savedEpisodes[0]!, episodeOrder: "OLDEST_FIRST" }],
    },
    {
      ...base,
      savedEpisodes: [{ ...base.savedEpisodes[0]!, randomPolicy: "WITH_REPLACEMENT" }],
    },
  ];

  for (const changed of mutations) {
    assert.notEqual(fingerprint(changed), original);
  }
});

test("Gate 6 fingerprints inheritance separately from an explicit SHOW override", () => {
  const base = snapshot();
  const inherited: Podcast07FingerprintSnapshot = {
    ...base,
    shows: [
      {
        sourcePlaylistId: "show-source",
        spotifyShowId: "show-a",
        authority: "INHERIT_SAVED_EPISODES",
        policy: null,
      },
    ],
  };

  assert.notEqual(fingerprint(inherited), fingerprint(base));
});

test("Gate 6 invalidates simulation when SHOW scope or effective policy changes", () => {
  const base = snapshot();
  const original = fingerprint(base);
  const show = base.shows[0]!;
  assert.equal(show.authority, "SHOW_OVERRIDE");
  if (show.authority !== "SHOW_OVERRIDE" || !show.policy) return;

  const scopeChanged: Podcast07FingerprintSnapshot = {
    ...base,
    shows: [
      {
        ...show,
        policy: { ...show.policy, showEpisodeScope: "SAVED_ONLY" },
      },
    ],
  };
  const orderChanged: Podcast07FingerprintSnapshot = {
    ...base,
    shows: [
      {
        ...show,
        policy: { ...show.policy, episodeOrder: "NEWEST_FIRST" },
      },
    ],
  };

  assert.notEqual(fingerprint(scopeChanged), original);
  assert.notEqual(fingerprint(orderChanged), original);
});
