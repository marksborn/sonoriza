import assert from "node:assert/strict";
import test from "node:test";

import { sequencePrewriteViolations } from "@/jobs/sequence-prewrite-guard";
import {
  buildKeepFilledPreservation,
  type CurrentTargetPlaylistItem,
} from "@/services/keep-filled-core";

import { planRun } from "./plan-run";
import { planPlaylist } from "./planner";
import {
  excludePodcastSnippetsFromPool,
  isPodcastSnippet,
  PODCAST_SNIPPET_MAX_DURATION_MS,
  podcastSnippetTargetEvidence,
  resolvePodcastSnippetMode,
  resolvePodcastSnippetPolicy,
} from "./podcast-snippet";
import type { Candidate, PlaylistRules } from "./types";

const MIN = 60_000;

function track(id: string, durationMs = 3 * MIN): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    albumId: `album-${id}`,
    durationMs,
  };
}

function episode(
  id: string,
  programId: string,
  durationMs: number,
  extra: Partial<Candidate> = {},
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    programId,
    spotifyEpisodeId: id,
    durationMs,
    ...extra,
  };
}

function rules(overrides: Partial<PlaylistRules> = {}): PlaylistRules {
  return {
    targetDurationMs: 30 * MIN,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: ["MUSIC"],
    maxEpisodesPerProgram: 1,
    ...overrides,
  };
}

const tracks = (count: number) =>
  Array.from({ length: count }, (_, index) => track(`m${index + 1}`));

// --- Classification -------------------------------------------------------

test("#559 5:00 is a Snippet, 5:00.001 is not, unknown durations never are", () => {
  assert.equal(PODCAST_SNIPPET_MAX_DURATION_MS, 300_000);
  assert.equal(isPodcastSnippet(episode("a", "s", 300_000)), true);
  assert.equal(isPodcastSnippet(episode("b", "s", 300_001)), false);
  assert.equal(isPodcastSnippet(episode("c", "s", 0)), false);
  assert.equal(isPodcastSnippet(episode("d", "s", Number.NaN)), false);
  assert.equal(isPodcastSnippet(track("t", 2 * MIN)), false);
});

test("#559 a 1 h IN_PROGRESS episode with 4 min left is not a Snippet", () => {
  const longWithRest = episode("long", "s", 4 * MIN, {
    originalDurationMs: 60 * MIN,
    resumePositionMs: 56 * MIN,
    podcastListeningStatus: "IN_PROGRESS",
  });
  assert.equal(isPodcastSnippet(longWithRest), false);
  // Without the total, a resumed episode cannot be proven short.
  assert.equal(
    isPodcastSnippet(episode("resumed", "s", 4 * MIN, { podcastListeningStatus: "IN_PROGRESS" })),
    false,
  );
  // A short episode in progress keeps its total and stays a Snippet.
  assert.equal(
    isPodcastSnippet(episode("short", "s", 1 * MIN, {
      originalDurationMs: 4 * MIN,
      podcastListeningStatus: "IN_PROGRESS",
    })),
    true,
  );
});

test("#559 mode defaults to OFF and the checkbox only matters under ACTIVE", () => {
  assert.equal(resolvePodcastSnippetMode(undefined), "OFF");
  assert.equal(resolvePodcastSnippetMode("shadow"), "OFF");
  assert.equal(resolvePodcastSnippetMode(" active "), "ACTIVE");
  assert.equal(resolvePodcastSnippetPolicy({ mode: "OFF", allowPodcastSnippets: true }), undefined);
  assert.equal(resolvePodcastSnippetPolicy({ mode: "ACTIVE", allowPodcastSnippets: false }), "EXCLUDE");
  assert.equal(resolvePodcastSnippetPolicy({ mode: "ACTIVE", allowPodcastSnippets: true }), "MUSIC_ROLE");
});

// --- Planner --------------------------------------------------------------

test("#559 legacy (no policy) keeps short episodes eligible in podcast positions", () => {
  const input = {
    rules: rules({ podcastPercent: 50, targetDurationMs: 12 * MIN }),
    pools: { music: tracks(4), podcasts: [episode("s1", "show-a", 3 * MIN)] },
  };
  const legacy = planPlaylist(input);
  assert.ok(legacy.items.some((item) => item.uri === "spotify:episode:s1"));
  assert.equal(legacy.stats.podcastSnippet, undefined);
  assert.equal(legacy.items.every((item) => item.compositionRole === undefined), true);
});

test("#559 100% music + checkbox off: only music, no Snippet", () => {
  const result = planPlaylist({
    rules: rules(),
    pools: { music: tracks(10), podcasts: [episode("s1", "show-a", 3 * MIN)] },
    podcastSnippetPolicy: "EXCLUDE",
  });
  assert.equal(result.items.every((item) => item.type === "MUSIC"), true);
  assert.equal(result.stats.podcastSnippet?.excludedCandidateCount, 1);
});

test("#559 unchecked excludes Snippets even from traditional podcast slots", () => {
  const result = planPlaylist({
    rules: rules({
      compositionMode: "SEQUENCE",
      sequencePattern: ["MUSIC", "PODCAST"],
      targetDurationMs: 40 * MIN,
    }),
    pools: {
      music: tracks(10),
      podcasts: [episode("s1", "show-a", 3 * MIN), episode("long", "show-b", 20 * MIN)],
    },
    podcastSnippetPolicy: "EXCLUDE",
  });
  const uris = result.items.map((item) => item.uri);
  assert.ok(!uris.includes("spotify:episode:s1"));
  assert.ok(uris.includes("spotify:episode:long"));
});

test("#559 100% music + checkbox on: a 3 min episode goes between songs", () => {
  const result = planPlaylist({
    rules: rules(),
    pools: { music: tracks(10), podcasts: [episode("s1", "show-a", 3 * MIN)] },
    podcastSnippetPolicy: "MUSIC_ROLE",
  });
  const index = result.items.findIndex((item) => item.uri === "spotify:episode:s1");
  assert.equal(index, 3, "after three real tracks");
  const snippet = result.items[index]!;
  assert.equal(snippet.type, "PODCAST");
  assert.equal(snippet.compositionRole, "MUSIC");
  assert.equal(result.stats.podcastCount, 0);
  assert.equal(result.stats.actualPodcastPercent, 0);
  assert.equal(result.stats.podcastSnippet?.musicRoleCount, 1);
  // No artist/album diversity bookkeeping for the episode.
  assert.equal(result.stats.distinctArtistCount, result.items.length - 1);
});

test("#559 SEQUENCE with only MUSIC slots also receives Snippets", () => {
  const result = planPlaylist({
    rules: rules({ compositionMode: "SEQUENCE", sequencePattern: ["MUSIC"] }),
    pools: { music: tracks(10), podcasts: [episode("s1", "show-a", 2 * MIN)] },
    podcastSnippetPolicy: "MUSIC_ROLE",
  });
  assert.equal(result.stats.sequenceQualityPassed, true);
  assert.equal(
    result.items.find((item) => item.uri === "spotify:episode:s1")?.compositionRole,
    "MUSIC",
  );
});

test("#559 Snippets do not bypass the per-show cap nor repeat across roles", () => {
  const result = planPlaylist({
    rules: rules({
      compositionMode: "SEQUENCE",
      sequencePattern: ["MUSIC", "MUSIC", "PODCAST"],
      targetDurationMs: 60 * MIN,
    }),
    pools: {
      music: tracks(20),
      podcasts: [
        episode("s1", "show-a", 3 * MIN),
        episode("s2", "show-a", 3 * MIN),
        episode("s3", "show-b", 3 * MIN),
      ],
    },
    podcastSnippetPolicy: "MUSIC_ROLE",
  });
  const episodes = result.items.filter((item) => item.type === "PODCAST");
  const uris = episodes.map((item) => item.uri);
  assert.equal(new Set(uris).size, uris.length, "an episode is placed once");
  const perShow = new Map<string, number>();
  for (const item of episodes) perShow.set(item.programId!, (perShow.get(item.programId!) ?? 0) + 1);
  assert.ok([...perShow.values()].every((count) => count <= 1));
});

test("#559 an ordered show's Snippet never jumps ahead of an earlier episode", () => {
  const ordered = { podcastStrictSequence: true };
  const result = planPlaylist({
    rules: rules({ maxEpisodesPerProgram: 2 }),
    pools: {
      music: tracks(10),
      podcasts: [
        episode("ep1", "show-a", 40 * MIN, ordered),
        episode("ep2", "show-a", 3 * MIN, ordered),
      ],
    },
    podcastSnippetPolicy: "MUSIC_ROLE",
  });
  assert.equal(result.items.some((item) => item.type === "PODCAST"), false);
});

test("#559 EXCLUDE holds an ordered show whose next episode is a Snippet", () => {
  const ordered = { podcastStrictSequence: true };
  const pool = [
    episode("ep1", "show-a", 3 * MIN, ordered),
    episode("ep2", "show-a", 20 * MIN, ordered),
    episode("other", "show-b", 20 * MIN),
  ];
  assert.deepEqual(
    excludePodcastSnippetsFromPool(pool).map((item) => item.uri),
    ["spotify:episode:other"],
  );
  const result = planPlaylist({
    rules: rules({ podcastPercent: 100, maxEpisodesPerProgram: 2, targetDurationMs: 60 * MIN }),
    pools: { music: [], podcasts: pool },
    podcastSnippetPolicy: "EXCLUDE",
  });
  assert.deepEqual(result.items.map((item) => item.uri), ["spotify:episode:other"]);
});

test("#559 a long IN_PROGRESS episode with a short rest is not inserted as music", () => {
  const result = planPlaylist({
    rules: rules(),
    pools: {
      music: tracks(10),
      podcasts: [
        episode("long", "show-a", 4 * MIN, {
          originalDurationMs: 60 * MIN,
          resumePositionMs: 56 * MIN,
          podcastListeningStatus: "IN_PROGRESS",
        }),
      ],
    },
    podcastSnippetPolicy: "MUSIC_ROLE",
  });
  assert.equal(result.items.some((item) => item.type === "PODCAST"), false);
});

test("#559 per-event blocks keep Snippet spacing and aggregate role stats", () => {
  const result = planRun({
    pools: {
      music: tracks(20),
      podcasts: [episode("s1", "show-a", 2 * MIN), episode("s2", "show-b", 2 * MIN)],
    },
    targets: [
      {
        targetPlaylistId: "t1",
        name: "Carro",
        priority: 0,
        rules: rules({ targetDurationMs: 27 * MIN }),
        durationBlocks: [
          { key: "e1", targetDurationMs: 7 * MIN },
          { key: "e2", targetDurationMs: 20 * MIN },
        ],
        podcastSnippetPolicy: "MUSIC_ROLE",
      },
    ],
  }).targets[0]!.result;
  const roles = result.items.map((item) =>
    item.type === "PODCAST" ? `S${item.planningBlockIndex}` : `m${item.planningBlockIndex}`,
  );
  // e1 holds two tracks; spacing continues, so the first Snippet lands in e2
  // only after the third real track overall.
  assert.deepEqual(roles.slice(0, 4), ["m0", "m0", "m1", "S1"]);
  assert.equal(result.stats.podcastSnippet?.musicRoleCount, 2);
  assert.equal(result.stats.podcastCount, 0);
});

test("#559 evidence counts what OFF still places in podcast positions", () => {
  const evidence = podcastSnippetTargetEvidence({
    targetPlaylistId: "t1",
    policy: undefined,
    allowPodcastSnippets: false,
    items: [
      episode("s1", "a", 3 * MIN),
      { ...episode("s2", "b", 3 * MIN), compositionRole: "MUSIC" },
      episode("long", "c", 30 * MIN),
      track("m1"),
    ],
  });
  assert.deepEqual(evidence, {
    targetPlaylistId: "t1",
    policy: null,
    allowPodcastSnippets: false,
    snippetsInPodcastRole: 1,
    snippetsInMusicRole: 1,
  });
});

// --- Prewrite guard ---------------------------------------------------------

const seqTarget = new Map([
  ["t1", { id: "t1", name: "Trabalho", compositionMode: "SEQUENCE", sequencePattern: ["MUSIC", "PODCAST"] }],
]);

test("#559 prewrite accepts a Snippet in a MUSIC position of a SEQUENCE", () => {
  const violations = sequencePrewriteViolations(
    [{
      targetPlaylistId: "t1",
      result: {
        items: [
          { type: "PODCAST", compositionRole: "MUSIC", position: 0, uri: "spotify:episode:s1", durationMs: 3 * MIN },
          { type: "PODCAST", position: 1, uri: "spotify:episode:p1", durationMs: 30 * MIN },
        ],
      },
    }],
    seqTarget,
  );
  assert.deepEqual(violations, []);
});

test("#559 prewrite blocks a music role on anything but a proven Snippet", () => {
  const violations = sequencePrewriteViolations(
    [{
      targetPlaylistId: "t1",
      result: {
        items: [
          { type: "PODCAST", compositionRole: "MUSIC", position: 0, uri: "spotify:episode:long", durationMs: 30 * MIN },
          { type: "PODCAST", position: 1, uri: "spotify:episode:p1", durationMs: 30 * MIN },
        ],
      },
    }],
    seqTarget,
  );
  assert.deepEqual(violations.map((violation) => violation.reason), ["INVALID_COMPOSITION_ROLE"]);
});

// --- KEEP_FILLED ---------------------------------------------------------------

function remoteSnippet(position: number): CurrentTargetPlaylistItem {
  return {
    position,
    uri: "spotify:episode:s1",
    type: "PODCAST",
    spotifyEpisodeId: "s1",
    programId: "show-a",
    title: "s1",
    originalDurationMs: 3 * MIN,
    providerResumePositionMs: 0,
    providerFullyPlayed: false,
    removableByUri: true,
  };
}

function remoteTrack(position: number, id: string): CurrentTargetPlaylistItem {
  const candidate = track(id);
  return {
    position,
    uri: candidate.uri,
    type: "MUSIC",
    musicCandidate: candidate,
    originalDurationMs: candidate.durationMs,
    removableByUri: true,
  };
}

function keepFilled(podcastSnippetMusicRole: boolean) {
  return buildKeepFilledPreservation({
    items: [remoteTrack(0, "m1"), remoteSnippet(1)],
    podcastStates: new Map([["s1", { status: "NOT_STARTED" as const, durationMs: 3 * MIN, resumePositionMs: 0 }]]),
    provenanceByUri: new Map([["spotify:episode:s1", { sourceIncludePlayed: false }]]),
    musicRepeatEnabled: false,
    blockedTrackIds: new Set(),
    rules: {
      compositionMode: "SEQUENCE",
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 1,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
    maxPodcastDurationMs: null,
    podcastSnippetMusicRole,
  });
}

test("#559 KEEP_FILLED keeps a published Snippet in its music position when allowed", () => {
  const kept = keepFilled(true);
  assert.equal(kept.removedCount, 0);
  assert.equal(kept.preserved[1]?.compositionRole, "MUSIC");
  assert.equal(kept.preserved[1]?.type, "PODCAST");
});

test("#559 KEEP_FILLED without the option keeps the legacy type check", () => {
  const legacy = keepFilled(false);
  assert.deepEqual(legacy.removals.map((removal) => removal.reason), ["SEQUENCE_TYPE_MISMATCH"]);
});
