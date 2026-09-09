import assert from "node:assert/strict";
import test from "node:test";

import type { CalendarEventCompositionPolicySnapshot } from "../calendar-event-composition-policy";
import {
  projectCalendar03EventComposition,
} from "./calendar-event-composition-shadow";
import type { Candidate, PlaylistRules } from "./types";

const MINUTE = 60_000;

function music(id: string, minutes: number): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: `artist:${id}`,
    albumId: `album:${id}`,
    durationMs: minutes * MINUTE,
  };
}

function podcast(
  id: string,
  minutes: number,
  options: Partial<Candidate> = {},
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId: `show:${id}`,
    durationMs: minutes * MINUTE,
    podcastListeningStatus: "NOT_STARTED",
    ...options,
  };
}

function rules(overrides: Partial<PlaylistRules> = {}): PlaylistRules {
  return {
    targetDurationMs: 30 * MINUTE,
    compositionMode: "SEQUENCE",
    podcastPercent: 50,
    sequencePattern: ["PODCAST", "MUSIC", "MUSIC", "MUSIC", "MUSIC", "MUSIC"],
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
    ...overrides,
  };
}

function policy(
  overrides: Partial<CalendarEventCompositionPolicySnapshot> = {},
): CalendarEventCompositionPolicySnapshot {
  return {
    targetPlaylistId: "carro",
    eventCompositionPolicy: "PODCAST_THEN_MUSIC",
    maxPodcastsPerEvent: 1,
    podcastEventSafetyMarginSeconds: 0,
    podcastEventDistribution: "EVERY_EVENT",
    podcastEveryNEvents: 1,
    podcastEventOffset: 0,
    ...overrides,
  };
}

function fiveMinuteMusic(count = 12): Candidate[] {
  return Array.from({ length: count }, (_, index) =>
    music(`m${index + 1}`, 5),
  );
}

test("Gate 2 projects the Carro 30/30/15/15 example without crossing blocks", () => {
  const projection = projectCalendar03EventComposition({
    policy: policy({
      podcastEventSafetyMarginSeconds: 120,
      podcastEventDistribution: "EVERY_N_EVENTS",
      podcastEveryNEvents: 2,
      podcastEventOffset: 0,
    }),
    blocks: [30, 30, 15, 15].map((minutes, index) => ({
      key: `E${index + 1}`,
      targetDurationMs: minutes * MINUTE,
    })),
    rules: rules(),
    pools: {
      podcasts: [
        podcast("priority-a", 23),
        podcast("normal-b", 27),
        podcast("normal-c", 12),
      ],
      music: [...fiveMinuteMusic(), music("fill-2", 2), music("fill-3", 3)],
    },
  });

  assert.equal(projection.status, "READY_SHADOW");
  assert.equal(projection.plannerInfluence, false);
  assert.equal(projection.spotifyWrites, false);
  assert.equal(projection.databaseWrites, false);

  assert.deepEqual(
    projection.blocks.map((block) => ({
      key: block.key,
      attempted: block.podcastAttempted,
      podcastUris: block.selectedPodcastUris,
      usableMinutes: block.podcastUsableDurationMs / MINUTE,
      diagnosticCodes: block.diagnosticCodes,
    })),
    [
      {
        key: "E1",
        attempted: true,
        podcastUris: ["spotify:episode:priority-a"],
        usableMinutes: 28,
        diagnosticCodes: ["EVENT_PODCAST_SELECTED"],
      },
      {
        key: "E2",
        attempted: false,
        podcastUris: [],
        usableMinutes: 28,
        diagnosticCodes: ["EVENT_PODCAST_DISTRIBUTION_SKIPPED"],
      },
      {
        key: "E3",
        attempted: true,
        podcastUris: ["spotify:episode:normal-c"],
        usableMinutes: 13,
        diagnosticCodes: ["EVENT_PODCAST_SELECTED"],
      },
      {
        key: "E4",
        attempted: false,
        podcastUris: [],
        usableMinutes: 13,
        diagnosticCodes: ["EVENT_PODCAST_DISTRIBUTION_SKIPPED"],
      },
    ],
  );

  assert.ok(
    projection.blocks.every(
      (block) => block.filledDurationMs <= block.targetDurationMs,
    ),
  );
  assert.deepEqual(
    projection.items
      .filter((item) => item.type === "PODCAST")
      .map((item) => [item.uri, item.planningBlockIndex]),
    [
      ["spotify:episode:priority-a", 0],
      ["spotify:episode:normal-c", 2],
    ],
  );
  assert.equal(
    projection.items.filter((item) => item.uri === "spotify:episode:priority-a").length,
    1,
  );
});

test("duration is only a filter: canonical podcast order wins over best fit", () => {
  const projection = projectCalendar03EventComposition({
    policy: policy(),
    blocks: [{ key: "30-min", targetDurationMs: 30 * MINUTE }],
    rules: rules(),
    pools: {
      podcasts: [
        podcast("priority-18", 18),
        podcast("normal-best-fit-28", 28),
      ],
      music: [music("fill-10", 10), music("fill-2", 2)],
    },
  });

  assert.deepEqual(projection.blocks[0]?.selectedPodcastUris, [
    "spotify:episode:priority-18",
  ]);
  assert.ok(
    !projection.items.some(
      (item) => item.uri === "spotify:episode:normal-best-fit-28",
    ),
  );
});

test("IN_PROGRESS uses remaining duration and can fit a smaller event", () => {
  const inProgress = podcast("resume", 12, {
    originalDurationMs: 40 * MINUTE,
    resumePositionMs: 28 * MINUTE,
    playbackPositionKnown: true,
    podcastListeningStatus: "IN_PROGRESS",
  });

  const projection = projectCalendar03EventComposition({
    policy: policy(),
    blocks: [{ key: "15-min", targetDurationMs: 15 * MINUTE }],
    rules: rules(),
    pools: {
      podcasts: [inProgress],
      music: [music("fill-3", 3)],
    },
  });

  assert.deepEqual(projection.blocks[0]?.selectedPodcastUris, [
    "spotify:episode:resume",
  ]);
  assert.equal(projection.blocks[0]?.podcastDurationMs, 12 * MINUTE);
  assert.equal(projection.blocks[0]?.filledDurationMs, 15 * MINUTE);
});

test("no fitting podcast degrades to music-only with an explainable diagnostic", () => {
  const projection = projectCalendar03EventComposition({
    policy: policy({ podcastEventSafetyMarginSeconds: 120 }),
    blocks: [{ key: "short", targetDurationMs: 15 * MINUTE }],
    rules: rules(),
    pools: {
      podcasts: [podcast("too-long", 24)],
      music: [music("m1", 5), music("m2", 5), music("m3", 5)],
    },
  });

  assert.deepEqual(projection.blocks[0]?.selectedPodcastUris, []);
  assert.deepEqual(projection.blocks[0]?.diagnosticCodes, [
    "EVENT_PODCAST_NO_FITTING_CANDIDATE",
  ]);
  assert.equal(projection.blocks[0]?.musicDurationMs, 15 * MINUTE);
  assert.equal(projection.blocks[0]?.deficitMs, 0);
});

test("EVERY_N_EVENTS offset=1 attempts podcast only in E2/E4", () => {
  const projection = projectCalendar03EventComposition({
    policy: policy({
      podcastEventDistribution: "EVERY_N_EVENTS",
      podcastEveryNEvents: 2,
      podcastEventOffset: 1,
    }),
    blocks: [1, 2, 3, 4].map((index) => ({
      key: `E${index}`,
      targetDurationMs: 10 * MINUTE,
    })),
    rules: rules(),
    pools: {
      podcasts: [podcast("p1", 5), podcast("p2", 5)],
      music: fiveMinuteMusic(8),
    },
  });

  assert.deepEqual(
    projection.blocks.map((block) => block.podcastAttempted),
    [false, true, false, true],
  );
  assert.deepEqual(
    projection.blocks.map((block) => block.selectedPodcastUris),
    [
      [],
      ["spotify:episode:p1"],
      [],
      ["spotify:episode:p2"],
    ],
  );
});

test("maxPodcastsPerEvent supports multiple whole podcasts inside the same window", () => {
  const projection = projectCalendar03EventComposition({
    policy: policy({ maxPodcastsPerEvent: 2 }),
    blocks: [{ key: "30-min", targetDurationMs: 30 * MINUTE }],
    rules: rules(),
    pools: {
      podcasts: [podcast("p10", 10), podcast("p12", 12), podcast("p9", 9)],
      music: [music("fill-8", 8)],
    },
  });

  assert.deepEqual(projection.blocks[0]?.selectedPodcastUris, [
    "spotify:episode:p10",
    "spotify:episode:p12",
  ]);
  assert.equal(projection.blocks[0]?.podcastDurationMs, 22 * MINUTE);
  assert.equal(projection.blocks[0]?.musicDurationMs, 8 * MINUTE);
  assert.equal(projection.blocks[0]?.filledDurationMs, 30 * MINUTE);
});

test("per-show cap is threaded across event blocks instead of resetting per window", () => {
  const sameShow = "show:shared";
  const projection = projectCalendar03EventComposition({
    policy: policy(),
    blocks: [
      { key: "E1", targetDurationMs: 10 * MINUTE },
      { key: "E2", targetDurationMs: 10 * MINUTE },
    ],
    rules: rules({ maxEpisodesPerProgram: 1 }),
    pools: {
      podcasts: [
        podcast("shared-1", 5, { programId: sameShow }),
        podcast("shared-2", 5, { programId: sameShow }),
      ],
      music: fiveMinuteMusic(4),
    },
  });

  assert.deepEqual(projection.blocks[0]?.selectedPodcastUris, [
    "spotify:episode:shared-1",
  ]);
  assert.deepEqual(projection.blocks[1]?.selectedPodcastUris, []);
  assert.deepEqual(projection.blocks[1]?.diagnosticCodes, [
    "EVENT_PODCAST_NO_FITTING_CANDIDATE",
  ]);
});

test("strict sequence does not jump to a later episode of the same show when the head does not fit", () => {
  const strictShow = "show:strict";
  const projection = projectCalendar03EventComposition({
    policy: policy(),
    blocks: [{ key: "15-min", targetDurationMs: 15 * MINUTE }],
    rules: rules(),
    pools: {
      podcasts: [
        podcast("strict-head", 20, {
          programId: strictShow,
          podcastStrictSequence: true,
        }),
        podcast("strict-next", 10, {
          programId: strictShow,
          podcastStrictSequence: true,
        }),
        podcast("other-show", 8),
      ],
      music: [music("fill-7", 7)],
    },
  });

  assert.deepEqual(projection.blocks[0]?.selectedPodcastUris, [
    "spotify:episode:other-show",
  ]);
  assert.ok(
    !projection.items.some((item) => item.uri === "spotify:episode:strict-next"),
  );
});

test("Gate 2 abstains instead of applying PODCAST_THEN_MUSIC to SUMMED/inherit paths", () => {
  const noBlocks = projectCalendar03EventComposition({
    policy: policy(),
    blocks: [],
    rules: rules(),
    pools: { podcasts: [], music: [] },
  });
  assert.equal(noBlocks.status, "ABSTAIN_NO_PER_EVENT_BLOCKS");

  const inherit = projectCalendar03EventComposition({
    policy: policy({ eventCompositionPolicy: "INHERIT_DESTINATION" }),
    blocks: [{ key: "E1", targetDurationMs: 30 * MINUTE }],
    rules: rules(),
    pools: { podcasts: [], music: [] },
  });
  assert.equal(inherit.status, "ABSTAIN_INHERIT_DESTINATION");
  assert.deepEqual(inherit.items, []);
});
