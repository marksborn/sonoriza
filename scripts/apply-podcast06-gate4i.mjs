import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(path, before, after) {
  const input = read(path);
  const first = input.indexOf(before);
  if (first < 0) throw new Error(`Pattern not found in ${path}: ${before.slice(0, 100)}`);
  if (input.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Pattern is not unique in ${path}: ${before.slice(0, 100)}`);
  }
  write(path, input.slice(0, first) + after + input.slice(first + before.length));
}

function replaceAllExact(path, before, after, expectedCount) {
  const input = read(path);
  const count = input.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(`Expected ${expectedCount} matches in ${path}, found ${count}: ${before.slice(0, 100)}`);
  }
  write(path, input.split(before).join(after));
}

// Prisma schema: keep show identity beside the episode identity.
replaceOnce(
  "prisma/schema.prisma",
  `  spotifyEpisodeId        String\n  spotifyUri              String`,
  `  spotifyEpisodeId        String\n  spotifyShowId           String?\n  spotifyUri              String`,
);
replaceOnce(
  "prisma/schema.prisma",
  `  @@index([userId, status])\n  @@index([userId, lastObservedAt])`,
  `  @@index([userId, status])\n  @@index([userId, spotifyShowId])\n  @@index([userId, lastObservedAt])`,
);

// Observation accepts missing provider metadata, but every real producer below
// explicitly forwards show identity whenever the provider returned it.
replaceOnce(
  "src/services/spotify/podcast-listening-state.ts",
  `export type PodcastListeningObservation = {\n  spotifyEpisodeId: string;\n  spotifyShowId: string | null;`,
  `export type PodcastListeningObservation = {\n  spotifyEpisodeId: string;\n  spotifyShowId?: string | null;`,
);

// Incremental source reads already contain show(id,name). Persist that same
// identity used by Candidate.programId; SHOW source has its source id fallback.
replaceOnce(
  "src/services/spotify/incremental-reader.ts",
  `          observations.push({\n            spotifyEpisodeId,\n            spotifyUri: episode.uri,`,
  `          observations.push({\n            spotifyEpisodeId,\n            spotifyShowId:\n              normalizedOptionalText(episode.show?.id) ??\n              normalizedOptionalText(fallbackProgramId),\n            spotifyUri: episode.uri,`,
);
replaceOnce(
  "src/services/spotify/incremental-reader.ts",
  `          const programId = episode.show?.id ?? fallbackProgramId;`,
  `          const programId =\n            normalizedOptionalText(episode.show?.id) ??\n            normalizedOptionalText(fallbackProgramId);`,
);
replaceOnce(
  "src/services/spotify/incremental-reader.ts",
  `function clamp(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value));\n}`,
  `function normalizedOptionalText(value: string | null | undefined): string | null {\n  const normalized = value?.trim();\n  return normalized ? normalized : null;\n}\n\nfunction clamp(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value));\n}`,
);

// The authoritative GET /episodes/{id} response also carries show.id. Typing
// and forwarding it requires no additional Spotify read.
replaceOnce(
  "src/services/spotify/podcast-authoritative-state.ts",
  `  type?: string;\n  resume_point?: {`,
  `  type?: string;\n  show?: {\n    id?: string;\n    name?: string;\n  } | null;\n  resume_point?: {`,
);
replaceOnce(
  "src/services/spotify/podcast-authoritative-state.ts",
  `  return {\n    spotifyEpisodeId,\n    spotifyUri,`,
  `  return {\n    spotifyEpisodeId,\n    spotifyShowId: normalizedOptionalText(episode.show?.id),\n    spotifyUri,`,
);
replaceOnce(
  "src/services/spotify/podcast-authoritative-state.ts",
  `function clamp(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value));\n}`,
  `function normalizedOptionalText(value: string | null | undefined): string | null {\n  const normalized = value?.trim();\n  return normalized ? normalized : null;\n}\n\nfunction clamp(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value));\n}`,
);

// Shadow: canonical show identity wins; current-pool mapping remains only a
// legacy fallback. A factual row with neither identity still fails closed.
replaceOnce(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.ts",
  `export type Podcast06ListeningStateEvidence = Readonly<{\n  spotifyEpisodeId: string;\n  status: PodcastCadenceListeningStatus;`,
  `export type Podcast06ListeningStateEvidence = Readonly<{\n  spotifyEpisodeId: string;\n  spotifyShowId: string | null;\n  status: PodcastCadenceListeningStatus;`,
);
replaceOnce(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.ts",
  `      factualListeningStateCount: input.listeningStates.filter(\n        (entry) => entry.firstProgressObservedAt !== null,\n      ).length,`,
  `      unresolvedFactualListeningStateCount: input.listeningStates.filter(\n        (entry) =>\n          entry.firstProgressObservedAt !== null &&\n          normalizedOptionalText(entry.spotifyShowId) === null,\n      ).length,`,
);
replaceOnce(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.ts",
  `    const spotifyShowId = episodeToShow.get(listeningState.spotifyEpisodeId) ?? null;`,
  `    const spotifyShowId =\n      normalizedOptionalText(listeningState.spotifyShowId) ??\n      episodeToShow.get(listeningState.spotifyEpisodeId) ??\n      null;`,
);
replaceAllExact(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.ts",
  `  factualListeningStateCount: number;`,
  `  unresolvedFactualListeningStateCount: number;`,
  1,
);
replaceOnce(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.ts",
  `    unresolvedFactualCount: input.factualListeningStateCount,`,
  `    unresolvedFactualCount: input.unresolvedFactualListeningStateCount,`,
);

// Wrapper loads canonical show provenance before entering the planner runtime.
replaceOnce(
  "src/jobs/generate-playlists.ts",
  `      select: {\n        spotifyEpisodeId: true,\n        status: true,`,
  `      select: {\n        spotifyEpisodeId: true,\n        spotifyShowId: true,\n        status: true,`,
);
replaceOnce(
  "src/jobs/generate-playlists.ts",
  `    listeningStates: podcastListeningStates.map((state) => ({\n      spotifyEpisodeId: state.spotifyEpisodeId,\n      status: state.status,`,
  `    listeningStates: podcastListeningStates.map((state) => ({\n      spotifyEpisodeId: state.spotifyEpisodeId,\n      spotifyShowId: state.spotifyShowId,\n      status: state.status,`,
);

// Unit state helper now exercises show provenance by default.
replaceOnce(
  "src/services/spotify/podcast-listening-state.test.ts",
  `    spotifyEpisodeId: "episode-1",\n    spotifyUri: "spotify:episode:episode-1",`,
  `    spotifyEpisodeId: "episode-1",\n    spotifyShowId: "show-a",\n    spotifyUri: "spotify:episode:episode-1",`,
);
replaceOnce(
  "src/services/spotify/podcast-listening-state.test.ts",
  `test("explicit completion becomes canonical COMPLETED without inventing baseline start time", () => {`,
  `test("show provenance is sticky when later provider metadata omits show identity", () => {\n  const first = mergePodcastListeningState(null, observation());\n  assert.equal(first.spotifyShowId, "show-a");\n\n  const later = mergePodcastListeningState(\n    first,\n    observation({ spotifyShowId: null }),\n  );\n  assert.equal(later.spotifyShowId, "show-a");\n});\n\ntest("conflicting show provenance fails closed instead of moving an episode", () => {\n  const first = mergePodcastListeningState(null, observation());\n  assert.throws(\n    () =>\n      mergePodcastListeningState(\n        first,\n        observation({ spotifyShowId: "show-b" }),\n      ),\n    /Podcast show provenance conflict/,\n  );\n});\n\ntest("explicit completion becomes canonical COMPLETED without inventing baseline start time", () => {`,
);

// Shadow tests: null means legacy pool fallback; canonical provenance proves
// historical factual consumption even if that episode is absent from the pool.
replaceAllExact(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.test.ts",
  `        spotifyEpisodeId: inProgress.spotifyEpisodeId!,\n        status: "IN_PROGRESS",`,
  `        spotifyEpisodeId: inProgress.spotifyEpisodeId!,\n        spotifyShowId: null,\n        status: "IN_PROGRESS",`,
  1,
);
replaceAllExact(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.test.ts",
  `        spotifyEpisodeId: next.spotifyEpisodeId!,\n        status: "NOT_STARTED",`,
  `        spotifyEpisodeId: next.spotifyEpisodeId!,\n        spotifyShowId: null,\n        status: "NOT_STARTED",`,
  1,
);
replaceOnce(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.test.ts",
  `test("unresolved factual consumption fails closed instead of undercounting cadence", () => {`,
  `test("canonical show provenance resolves factual consumption outside the current pool", () => {\n  const next = podcast({\n    id: "next-scicast",\n    showId: SCICAST,\n    status: "NOT_STARTED",\n  });\n  const result = projectPodcast06PlannerShadow({\n    policies: new Map([\n      [SCICAST, policy({ showId: SCICAST, max: 1, unit: "WEEK" })],\n    ]),\n    listeningStates: [\n      {\n        spotifyEpisodeId: "historical-not-in-pool",\n        spotifyShowId: SCICAST,\n        status: "COMPLETED",\n        firstProgressObservedAt: new Date("2026-09-07T12:00:00Z"),\n      },\n    ],\n    timeZone: "America/Sao_Paulo",\n    asOf: new Date("2026-09-07T22:00:00Z"),\n    candidates: [next],\n  });\n\n  assert.equal(result.status, "READY_SHADOW");\n  assert.equal(result.unresolvedFactualCount, 0);\n  assert.equal(result.shows[0]?.consumedCount, 1);\n  assert.equal(result.shows[0]?.limitReached, true);\n  assert.equal(result.shows[0]?.newEpisodeAllowedByCadence, false);\n  assert.deepEqual(result.shows[0]?.projectedBlockedEpisodeIds, ["next-scicast"]);\n});\n\ntest("unresolved factual consumption fails closed instead of undercounting cadence", () => {`,
);
replaceAllExact(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.test.ts",
  `        spotifyEpisodeId: "historical-not-in-pool",\n        status: "COMPLETED",`,
  `        spotifyEpisodeId: "historical-not-in-pool",\n        spotifyShowId: null,\n        status: "COMPLETED",`,
  1,
);
replaceAllExact(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.test.ts",
  `        spotifyEpisodeId: "factual",\n        status: "IN_PROGRESS",`,
  `        spotifyEpisodeId: "factual",\n        spotifyShowId: null,\n        status: "IN_PROGRESS",`,
  1,
);
replaceAllExact(
  "src/services/playlist-planner/podcast-cadence-shadow-runtime.test.ts",
  `        spotifyEpisodeId: "not-started",\n        status: "NOT_STARTED",`,
  `        spotifyEpisodeId: "not-started",\n        spotifyShowId: null,\n        status: "NOT_STARTED",`,
  1,
);

// Dedicated validation must keep covering every producer of show provenance.
replaceOnce(
  ".github/workflows/podcast-06-validation.yml",
  `      - "src/services/spotify/podcast-listening-state.integration.test.ts"\n      - "src/services/spotify/podcast-show-cadence-contract.ts"`,
  `      - "src/services/spotify/podcast-listening-state.integration.test.ts"\n      - "src/services/spotify/incremental-reader.ts"\n      - "src/services/spotify/podcast-authoritative-state.ts"\n      - "src/services/spotify/podcast-page-ingestion.test.ts"\n      - "src/services/spotify/podcast-authoritative-state.test.ts"\n      - "src/services/spotify/podcast-show-cadence-contract.ts"`,
);
replaceOnce(
  ".github/workflows/podcast-06-validation.yml",
  `      - "src/services/spotify/podcast-listening-state.integration.test.ts"\n      - "src/services/spotify/podcast-show-cadence-contract.ts"`,
  `      - "src/services/spotify/podcast-listening-state.integration.test.ts"\n      - "src/services/spotify/incremental-reader.ts"\n      - "src/services/spotify/podcast-authoritative-state.ts"\n      - "src/services/spotify/podcast-page-ingestion.test.ts"\n      - "src/services/spotify/podcast-authoritative-state.test.ts"\n      - "src/services/spotify/podcast-show-cadence-contract.ts"`,
);
replaceOnce(
  ".github/workflows/podcast-06-validation.yml",
  `          src/services/spotify/podcast-listening-state.integration.test.ts\n          src/services/spotify/podcast-show-cadence-contract.test.ts`,
  `          src/services/spotify/podcast-listening-state.integration.test.ts\n          src/services/spotify/podcast-page-ingestion.test.ts\n          src/services/spotify/podcast-authoritative-state.test.ts\n          src/services/spotify/podcast-show-cadence-contract.test.ts`,
);

console.log("PODCAST-06 Gate 4I source patch applied.");
