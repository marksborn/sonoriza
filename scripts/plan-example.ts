/**
 * Framework-free demonstration of the planning engine — no Spotify, no Google,
 * no database. Run it to see the two-playlist use case (Car first, then Work)
 * with cross-playlist exclusivity, proportion and the play sequence.
 *
 *   npx tsx scripts/plan-example.ts
 */
import {
  planRun,
  type Candidate,
  type ContentType,
  type RunTarget,
} from "@/services/playlist-planner";

function make(
  type: ContentType,
  count: number,
  minutes: number,
  program?: string,
): Candidate[] {
  return Array.from({ length: count }, (_, i) => ({
    uri: `spotify:${type === "MUSIC" ? "track" : "episode"}:${program ?? type}-${i}`,
    type,
    title: `${program ?? type} ${i + 1}`,
    subtitle: program,
    programId: type === "PODCAST" ? program : undefined,
    durationMs: minutes * 60_000,
  }));
}

const pools = {
  music: make("MUSIC", 300, 3.5),
  podcasts: [
    ...make("PODCAST", 20, 40, "show-a"),
    ...make("PODCAST", 20, 35, "show-b"),
    ...make("PODCAST", 20, 50, "show-c"),
  ],
};

const sequence: ContentType[] = ["MUSIC", "PODCAST", "MUSIC", "MUSIC", "PODCAST"];

const targets: RunTarget[] = [
  {
    targetPlaylistId: "car",
    name: "Carro",
    priority: 0, // generated first, reserves its content
    rules: {
      targetDurationMs: 90 * 60_000, // ~90 min of trips
      podcastPercent: 60,
      sequencePattern: sequence,
      maxEpisodesPerProgram: 1,
    },
  },
  {
    targetPlaylistId: "work",
    name: "Trabalho",
    priority: 1, // gets only what's left
    rules: {
      targetDurationMs: 8 * 60 * 60_000, // 8 h
      podcastPercent: 60,
      sequencePattern: sequence,
      maxEpisodesPerProgram: 1,
    },
  },
];

const { targets: results } = planRun({ pools, targets });

for (const { name, result } of results) {
  const { stats } = result;
  console.log(`\n=== ${name} ===`);
  console.log(
    `items: ${result.items.length} | total ${Math.round(
      stats.totalDurationMs / 60000,
    )} min | music ${stats.musicCount} (${Math.round(
      stats.musicDurationMs / 60000,
    )}m) | podcasts ${stats.podcastCount} (${Math.round(
      stats.podcastDurationMs / 60000,
    )}m)`,
  );
  console.log(
    `pattern head: ${result.items
      .slice(0, 8)
      .map((i) => (i.type === "MUSIC" ? "M" : "P"))
      .join(" ")} ...`,
  );
}

// Sanity: no URI appears in both playlists.
const carUris = new Set(results[0]!.result.items.map((i) => i.uri));
const overlap = results[1]!.result.items.filter((i) => carUris.has(i.uri));
console.log(`\nOverlap between playlists: ${overlap.length} (expected 0)`);
