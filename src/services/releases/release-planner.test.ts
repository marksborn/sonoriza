import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner/types";

import {
  isLikelyReissue,
  readReleasesTargetReviews,
  releaseCandidatesForPlanner,
  resolveReleasesPlannerMode,
  spreadReleasesIntoPool,
} from "./release-planner";
import type { ReleaseRadarRelease } from "./release-radar";

const track = (id: string, alreadyHeard = false) => ({
  spotifyTrackId: id,
  uri: `spotify:track:${id}`,
  name: id,
  durationMs: 200_000,
  alreadyHeard,
});

const release = (overrides: Partial<ReleaseRadarRelease>): ReleaseRadarRelease => ({
  albumId: "alb",
  name: "Record",
  albumType: "album",
  releaseDate: "2026-10-25",
  artists: ["Artist"],
  imageUrl: null,
  seedArtistId: "0OdUWJ0sBjDrqHygGUXeCF",
  tracks: [track("a"), track("b"), track("c")],
  ...overrides,
});

test("reissue heuristic catches the radar's real reissue and common markers", () => {
  assert.equal(isLikelyReissue({ name: "Too Fast For Love (Leathür Records Version)", albumType: "album" }), true);
  for (const name of ["Hybrid Theory (20th Anniversary Edition)", "Abbey Road (Remastered)", "Album Deluxe", "Red (Taylor's Version)"]) {
    assert.equal(isLikelyReissue({ name, albumType: "album" }), true, name);
  }
  for (const name of ["Won't Get Fooled Again", "Vida (Morte)", "Version Control"]) {
    assert.equal(isLikelyReissue({ name, albumType: "single" }), false, name);
  }
});

test("selection: newest first, 2 per album, 1 per single, heard and reissues excluded", () => {
  const selection = releaseCandidatesForPlanner([
    release({ albumId: "old", releaseDate: "2026-10-01", tracks: [track("o1"), track("o2"), track("o3")] }),
    release({ albumId: "single", albumType: "single", releaseDate: "2026-10-30", tracks: [track("s1"), track("s2")] }),
    release({ albumId: "heard", releaseDate: "2026-10-29", tracks: [track("h1", true), track("h2")] }),
    release({ albumId: "re", name: "X (Remastered)", releaseDate: "2026-10-28" }),
  ]);
  assert.deepEqual(
    selection.candidates.map((candidate) => candidate.spotifyTrackId),
    ["s1", "h2", "o1", "o2"],
  );
  assert.equal(selection.reissueExcluded, 1);
  assert.equal(selection.heardExcluded, 1);
  assert.equal(selection.candidates[0]!.albumId, "single");
  assert.equal(selection.candidates[0]!.type, "MUSIC");
});

const music = (id: string): Candidate => ({ uri: `spotify:track:${id}`, type: "MUSIC", title: id, durationMs: 200_000 });

test("spread: capped, spaced through the pool, no duplicates", () => {
  const pool = Array.from({ length: 10 }, (_, i) => music(`p${i}`));
  const releases = [music("r1"), music("r2"), music("p3"), music("r3")];
  const { pool: spread, injected } = spreadReleasesIntoPool(pool, releases, 2);
  assert.deepEqual(injected.map((c) => c.uri), ["spotify:track:r1", "spotify:track:r2"]);
  assert.equal(spread.length, 12);
  assert.equal(spread[1]!.uri, "spotify:track:r1");
  assert.equal(spread[6]!.uri, "spotify:track:r2");
  assert.equal(spreadReleasesIntoPool(pool, releases, 0).injected.length, 0);
  assert.equal(spreadReleasesIntoPool([], [music("r1")], 4).pool.length, 1);
});

test("mode defaults to SHADOW; only literal OFF/ACTIVE change it", () => {
  assert.equal(resolveReleasesPlannerMode(undefined), "SHADOW");
  assert.equal(resolveReleasesPlannerMode("active"), "ACTIVE");
  assert.equal(resolveReleasesPlannerMode("off"), "OFF");
  assert.equal(resolveReleasesPlannerMode("yes"), "SHADOW");
});

test("review reader labels SHADOW, ACTIVE, stale and empty", () => {
  const summary = {
    targetDiscoveryRuntime: {
      evidence: {
        releases: [
          { targetPlaylistId: "a", mode: "SHADOW", radarFresh: true, injected: [{ title: "Song", artists: "Band" }] },
          { targetPlaylistId: "b", mode: "ACTIVE", radarFresh: true, injected: [{ title: "Song" }] },
          { targetPlaylistId: "c", mode: "SHADOW", radarFresh: false, injected: [] },
          { targetPlaylistId: "d", mode: "SHADOW", radarFresh: true, injected: [] },
        ],
      },
    },
  };
  const reviews = readReleasesTargetReviews(summary);
  assert.match(reviews.get("a")!.label, /entrariam/);
  assert.deepEqual(reviews.get("a")!.titles, ["Song — Band"]);
  assert.match(reviews.get("b")!.label, /entraram/);
  assert.match(reviews.get("c")!.label, /desatualizado/);
  assert.match(reviews.get("d")!.label, /nenhuma novidade/);
  assert.equal(readReleasesTargetReviews(null).size, 0);
});

test("collector wires releases only from the cached radar and through the run filter", () => {
  const source = readFileSync("src/jobs/incremental-planning.ts", "utf8");
  assert.match(source, /readReleaseRadar\(targetDiscoveryState\.userId\)/);
  assert.match(source, /filterMusicBatchForCurrentRun\(releaseSelection\.candidates\)/);
  assert.match(source, /if \(releasesMode === "ACTIVE"\) targetPool = spread\.pool;/);
});
