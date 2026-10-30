import assert from "node:assert/strict";
import test from "node:test";

import { sequencePrewriteViolations } from "@/jobs/sequence-prewrite-guard";

import { planRun, type PlanRunInput } from "./plan-run";
import type { Candidate } from "./types";

const MIN = 60_000;
const music = (id: string, minutes = 4): Candidate => ({
  uri: `spotify:track:${id}`, type: "MUSIC", title: id, spotifyTrackId: id,
  primaryArtistId: `a:${id}`, albumId: `b:${id}`, durationMs: minutes * MIN,
});
const podcast = (id: string, minutes: number): Candidate => ({
  uri: `spotify:episode:${id}`, type: "PODCAST", title: id, spotifyEpisodeId: id,
  programId: `show:${id}`, durationMs: minutes * MIN,
});

function input(offset: number, blocks = false): PlanRunInput {
  return {
    pools: {
      music: Array.from({ length: 20 }, (_, i) => music(`m${i}`)),
      podcasts: [podcast("short", 20), podcast("long", 70), podcast("short2", 25)],
    },
    targets: [{
      targetPlaylistId: "work",
      name: "Trabalho",
      priority: 0,
      rules: {
        targetDurationMs: 120 * MIN,
        compositionMode: "SEQUENCE",
        podcastPercent: 0,
        sequencePattern: ["MUSIC", "PODCAST", "MUSIC", "PODCAST"],
        maxEpisodesPerProgram: 1,
      },
      ...(blocks
        ? { durationBlocks: [{ key: "E1", targetDurationMs: 90 * MIN }, { key: "E2", targetDurationMs: 90 * MIN }] }
        : {}),
      ...(offset ? { sequenceStartOffset: offset } : {}),
      podcast08ActivePolicy: {
        bands: ["ANY", "SHORT", "ANY", "LONG"],
        limits: { shortMaxMinutes: 30, mediumMaxMinutes: 60 },
      },
    }],
  };
}

const types = (out: ReturnType<typeof planRun>) =>
  out.targets[0]!.result.items.map((item) => (item.type === "PODCAST" ? "P" : "M"));

test("offset 2 (book = first PODCAST) resumes at the slot after it", () => {
  const out = planRun(input(2));
  assert.deepEqual(types(out).slice(0, 4), ["M", "P", "M", "P"]);
  // The first planned podcast uses the band of pattern slot 3 (LONG), not slot 1.
  const firstPodcast = out.targets[0]!.result.items.find((item) => item.type === "PODCAST");
  assert.equal(firstPodcast?.uri, "spotify:episode:long");
});

test("segmented targets continue the shifted pattern across events", () => {
  const out = planRun(input(2, true));
  const items = out.targets[0]!.result.items;
  assert.equal(items[0]!.type, "MUSIC");
  assert.equal(items.find((item) => item.type === "PODCAST")?.uri, "spotify:episode:long");
});

test("sequence guard accepts the shifted plan only with the same offset", () => {
  const out = planRun(input(2));
  const target = {
    id: "work",
    name: "Trabalho",
    compositionMode: "SEQUENCE",
    sequencePattern: ["MUSIC", "PODCAST", "MUSIC", "PODCAST"],
  };
  const planned = out.targets.map((entry) => ({
    targetPlaylistId: entry.targetPlaylistId,
    result: { items: entry.result.items.map((item) => ({ type: item.type, position: item.position, uri: item.uri })) },
  }));
  const byId = new Map([["work", target]]);
  assert.deepEqual(sequencePrewriteViolations(planned, byId, new Map([["work", 2]])), []);
});
