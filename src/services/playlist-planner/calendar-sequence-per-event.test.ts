import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCalendarEventCompositionPolicy,
  type CalendarEventCompositionPolicyInput,
} from "../calendar-event-composition-policy";
import { projectCalendar04SequencePerEvent } from "./calendar-sequence-per-event";
import type { Candidate, ContentType, PlaylistRules } from "./types";

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

function podcast(id: string, minutes: number, programId = `show:${id}`): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId,
    durationMs: minutes * MINUTE,
    podcastListeningStatus: "NOT_STARTED",
  };
}

function rules(pattern: ContentType[] = ["PODCAST", "MUSIC"]): PlaylistRules {
  return {
    targetDurationMs: 0,
    compositionMode: "SEQUENCE",
    podcastPercent: 0,
    sequencePattern: pattern,
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
  };
}

function policy(overrides: Partial<CalendarEventCompositionPolicyInput> = {}) {
  return normalizeCalendarEventCompositionPolicy("carro", {
    eventCompositionPolicy: "SEQUENCE_PER_EVENT",
    maxPodcastsPerEvent: 1,
    podcastEventSafetyMarginSeconds: 0,
    podcastEventDistribution: "EVERY_EVENT",
    remainderFillStrategy: "MUSIC_ONLY",
    ...overrides,
  });
}

function blocks(...minutes: number[]) {
  return minutes.map((value, index) => ({
    key: `E${index + 1}`,
    targetDurationMs: value * MINUTE,
  }));
}

function musicPool(count: number, minutes = 4): Candidate[] {
  return Array.from({ length: count }, (_, index) => music(`m${index + 1}`, minutes));
}

function typesOfBlock(
  projection: ReturnType<typeof projectCalendar04SequencePerEvent>,
  blockIndex: number,
) {
  return projection.items
    .filter((item) => item.planningBlockIndex === blockIndex)
    .map((item) => `${item.type === "PODCAST" ? "P" : "M"}${item.durationMs / MINUTE}`);
}

test("MUSIC_ONLY: P22 → M4 first, then only music in the 80 min event", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy(),
    blocks: blocks(80),
    rules: rules(),
    pools: { podcasts: [podcast("p1", 22), podcast("p2", 20)], music: musicPool(30) },
  });

  assert.equal(projection.status, "READY_SHADOW");
  const types = typesOfBlock(projection, 0);
  assert.deepEqual(types.slice(0, 2), ["P22", "M4"]);
  assert.ok(types.slice(2).every((entry) => entry.startsWith("M")));
  const block = projection.blocks[0]!;
  assert.equal(block.calendar04.remainderAfterSequenceMs, 54 * MINUTE);
  assert.equal(block.filledDurationMs, 78 * MINUTE);
  assert.ok(block.filledDurationMs <= block.targetDurationMs);
  // 4 min tracks cannot close the last 2 min without crossing the boundary.
  assert.equal(block.deficitMs, 2 * MINUTE);
  assert.deepEqual(block.diagnosticCodes, [
    "EVENT_SEQUENCE_COMPLETED",
    "EVENT_REMAINDER_FILLED",
    "EVENT_REMAINDER_GAP_LEFT",
  ]);
});

test("every event restarts at the first slot instead of continuing the cursor", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy(),
    blocks: blocks(30, 25),
    rules: rules(["PODCAST", "MUSIC"]),
    pools: {
      podcasts: [podcast("p1", 20), podcast("p2", 15)],
      music: musicPool(20, 5),
    },
  });

  assert.deepEqual(typesOfBlock(projection, 0).slice(0, 2), ["P20", "M5"]);
  assert.deepEqual(typesOfBlock(projection, 1).slice(0, 2), ["P15", "M5"]);
});

test("PODCAST_ONLY never cuts an episode and falls back to music when allowed", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy({ remainderFillStrategy: "PODCAST_ONLY", remainderFallback: "FILL_WITH_MUSIC" }),
    blocks: blocks(80),
    rules: rules(),
    pools: {
      podcasts: [podcast("p1", 22), podcast("p2", 30), podcast("p3", 60)],
      music: musicPool(30),
    },
  });

  const block = projection.blocks[0]!;
  assert.deepEqual(typesOfBlock(projection, 0).slice(0, 3), ["P22", "M4", "P30"]);
  assert.equal(block.calendar04.remainderPodcastDurationMs, 30 * MINUTE);
  assert.ok(block.calendar04.fallbackMusicDurationMs > 0);
  assert.ok(block.diagnosticCodes.includes("EVENT_REMAINDER_FALLBACK_MUSIC"));
  assert.ok(!projection.items.some((item) => item.uri === "spotify:episode:p3"));
});

test("LEAVE_GAP keeps the unfilled time empty and reports it", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy({ remainderFillStrategy: "PODCAST_ONLY", remainderFallback: "LEAVE_GAP" }),
    blocks: blocks(80),
    rules: rules(),
    pools: { podcasts: [podcast("p1", 22)], music: musicPool(30) },
  });

  const block = projection.blocks[0]!;
  assert.deepEqual(typesOfBlock(projection, 0), ["P22", "M4"]);
  assert.equal(block.deficitMs, 54 * MINUTE);
  assert.ok(block.diagnosticCodes.includes("EVENT_REMAINDER_GAP_LEFT"));
  assert.equal(block.calendar04.fallbackMusicDurationMs, 0);
});

test("MIX_RATIO splits only the remainder by duration", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy({ remainderFillStrategy: "MIX_RATIO", remainderPodcastPercent: 30 }),
    blocks: blocks(80),
    rules: rules(),
    pools: {
      podcasts: [podcast("p1", 22), podcast("p2", 16), podcast("p3", 15)],
      music: musicPool(40, 2),
    },
  });

  const block = projection.blocks[0]!;
  const remainder = block.calendar04;
  assert.equal(remainder.initialPodcastDurationMs, 22 * MINUTE);
  assert.equal(remainder.requestedRemainderPodcastPercent, 30);
  const filledRemainder = remainder.remainderMusicDurationMs + remainder.remainderPodcastDurationMs;
  assert.ok(filledRemainder > 0);
  const actualPercent = (remainder.remainderPodcastDurationMs / filledRemainder) * 100;
  assert.ok(actualPercent > 0 && actualPercent <= 40, `actual ${actualPercent}`);
  assert.ok(block.filledDurationMs <= block.targetDurationMs);
});

test("MIX_RATIO accepts the 0 and 100 extremes", () => {
  const pools = {
    podcasts: [podcast("p1", 22), podcast("p2", 20), podcast("p3", 20)],
    music: musicPool(40),
  };
  const none = projectCalendar04SequencePerEvent({
    policy: policy({ remainderFillStrategy: "MIX_RATIO", remainderPodcastPercent: 0 }),
    blocks: blocks(80),
    rules: rules(),
    pools,
  });
  assert.equal(none.blocks[0]!.calendar04.remainderPodcastDurationMs, 0);

  const all = projectCalendar04SequencePerEvent({
    policy: policy({ remainderFillStrategy: "MIX_RATIO", remainderPodcastPercent: 100 }),
    blocks: blocks(80),
    rules: rules(),
    pools,
  });
  assert.equal(all.blocks[0]!.calendar04.remainderPodcastDurationMs, 40 * MINUTE);
});

test("REPEAT_SEQUENCE cycles inside the event and terminates", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy({ remainderFillStrategy: "REPEAT_SEQUENCE" }),
    blocks: blocks(80),
    rules: rules(),
    pools: {
      podcasts: [podcast("p1", 22), podcast("p2", 20), podcast("p3", 18)],
      music: musicPool(30),
    },
  });

  assert.deepEqual(typesOfBlock(projection, 0).slice(0, 6), ["P22", "M4", "P20", "M4", "P18", "M4"]);
  assert.ok(projection.blocks[0]!.filledDurationMs <= 80 * MINUTE);
});

test("an unfillable podcast slot is skipped, not carried to the next event", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy(),
    blocks: blocks(15, 40),
    rules: rules(),
    pools: { podcasts: [podcast("p1", 30)], music: musicPool(30, 5) },
  });

  assert.ok(typesOfBlock(projection, 0).every((entry) => entry.startsWith("M")));
  assert.ok(
    projection.blocks[0]!.diagnosticCodes.includes("EVENT_SEQUENCE_SLOT_UNFILLED_PODCAST"),
  );
  assert.equal(typesOfBlock(projection, 1)[0], "P30");
});

test("show cap is shared across events through the canonical planner", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy(),
    blocks: blocks(30, 30),
    rules: rules(),
    pools: {
      podcasts: [podcast("a1", 20, "show:a"), podcast("a2", 20, "show:a")],
      music: musicPool(20, 5),
    },
  });

  const podcasts = projection.items.filter((item) => item.type === "PODCAST");
  assert.equal(podcasts.length, 1);
  assert.ok(
    projection.blocks[1]!.diagnosticCodes.includes("EVENT_SEQUENCE_SLOT_UNFILLED_PODCAST"),
  );
});

test("reserved URIs are never selected and no URI repeats across events", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy({ remainderFillStrategy: "REPEAT_SEQUENCE" }),
    blocks: blocks(25, 25, 25),
    rules: rules(["MUSIC", "PODCAST", "MUSIC"]),
    pools: {
      podcasts: [podcast("p1", 10), podcast("p2", 10)],
      music: musicPool(25, 3),
    },
    reserved: ["spotify:track:m1"],
  });

  const uris = projection.items.map((item) => item.uri);
  assert.equal(new Set(uris).size, uris.length);
  assert.ok(!uris.includes("spotify:track:m1"));
  for (const block of projection.blocks) {
    assert.ok(block.filledDurationMs <= block.targetDurationMs);
  }
});

test("music-only sequence with PODCAST_ONLY remainder degrades to the fallback", () => {
  const projection = projectCalendar04SequencePerEvent({
    policy: policy({ remainderFillStrategy: "PODCAST_ONLY" }),
    blocks: blocks(20),
    rules: rules(["MUSIC"]),
    pools: { podcasts: [], music: musicPool(10, 5) },
  });

  assert.deepEqual(typesOfBlock(projection, 0), ["M5", "M5", "M5", "M5"]);
  assert.equal(projection.blocks[0]!.deficitMs, 0);
});

test("abstains without SEQUENCE pattern, without blocks or with another policy", () => {
  const pools = { podcasts: [], music: musicPool(5) };
  assert.equal(
    projectCalendar04SequencePerEvent({
      policy: policy(),
      blocks: blocks(20),
      rules: { ...rules(), compositionMode: "PROPORTION" },
      pools,
    }).status,
    "ABSTAIN_NO_SEQUENCE_PATTERN",
  );
  assert.equal(
    projectCalendar04SequencePerEvent({ policy: policy(), blocks: [], rules: rules(), pools }).status,
    "ABSTAIN_NO_PER_EVENT_BLOCKS",
  );
  assert.equal(
    projectCalendar04SequencePerEvent({
      policy: normalizeCalendarEventCompositionPolicy("carro", {
        eventCompositionPolicy: "INHERIT_DESTINATION",
        maxPodcastsPerEvent: 1,
        podcastEventSafetyMarginSeconds: 0,
        podcastEventDistribution: "EVERY_EVENT",
      }),
      blocks: blocks(20),
      rules: rules(),
      pools,
    }).status,
    "ABSTAIN_INHERIT_DESTINATION",
  );
});
