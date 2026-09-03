import { prisma } from "@/lib/prisma";
import { buildMusic06NegativeProjectionShadowReport } from "@/services/music-preference/lastfm-negative-projection-shadow-report";

type Args = {
  email: string | null;
  username: string | null;
  runIds: string[];
  maxPages: number | undefined;
  windowHours: number | undefined;
  top: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) throw new Error("--email=<Sonoriza user email> is required");
  if (args.runIds.length === 0) {
    throw new Error("Use at least one --run-id=<GenerationRun id>");
  }

  const apiKey = process.env.LASTFM_API_KEY?.trim();
  const username = args.username ?? process.env.LASTFM_USERNAME?.trim() ?? null;
  if (!apiKey) throw new Error("Configure LASTFM_API_KEY before MUSIC-06 Gate 4 report");
  if (!username) {
    throw new Error("Use --username=<Last.fm user> or configure LASTFM_USERNAME");
  }

  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const report = await buildMusic06NegativeProjectionShadowReport({
    userId: user.id,
    generationRunIds: args.runIds,
    username,
    apiKey,
    prismaClient: prisma,
    maxPages: args.maxPages,
    defaultWindowHours: args.windowHours,
  });
  const projection = report.projection;

  console.log("========== MUSIC-06 GATE 4 — NEGATIVE PROJECTION SHADOW ==========");
  console.log(`Mode:                  ${report.mode}`);
  console.log(`Sonoriza user:         ${user.email ?? user.id}`);
  console.log(`Last.fm user:          ${report.username}`);
  console.log(`Generation runs:       ${report.generationRunIds.length}`);
  console.log(`As of:                 ${projection.asOf.toISOString()}`);
  console.log(`Assessed occurrences:  ${projection.assessedOccurrenceCount}`);
  console.log(`Negative occurrences:  ${projection.negativeOccurrenceCount}`);
  console.log(`Duplicate occurrences: ${projection.duplicateOccurrenceCount}`);
  console.log(`Conflicting rows:      ${projection.conflictingOccurrenceCount}`);
  console.log(`Unprojectable rows:    ${projection.unprojectableOccurrenceCount}`);

  console.log("");
  console.log("Source runs:");
  for (const source of report.sourceReports) {
    const statuses = source.targets
      .map((target) => `${target.targetPlaylistId}:${target.coverageStatus}`)
      .join(", ");
    console.log(
      `  ${source.coverage.generationRunId}: assessed=${source.assessedWindowCount} ` +
        `gaps=${source.inferredGapCount} coverage=[${statuses || "-"}]`,
    );
  }

  console.log("");
  console.log(`Tracks (top ${args.top}):`);
  for (const track of projection.tracks.slice(0, args.top)) {
    console.log(
      `  ${track.artistName} — ${track.trackName}: ` +
        `${track.inferredSkipCount}/${track.assessedOccurrenceCount} ` +
        `skipRate=${formatRate(track.skipRate)} ` +
        `30d=${formatRate(track.recent30dSkipRate)} ` +
        `90d=${formatRate(track.recent90dSkipRate)} ` +
        `days=${track.distinctNegativeDays}`,
    );
  }
  if (projection.tracks.length === 0) console.log("  (none)");

  console.log("");
  console.log(`Artists (top ${args.top}):`);
  for (const artist of projection.artists.slice(0, args.top)) {
    console.log(
      `  ${artist.artistName}: ` +
        `${artist.negativeOccurrenceCount}/${artist.assessedOccurrenceCount} ` +
        `skipRate=${formatRate(artist.skipRate)} ` +
        `tracks=${artist.distinctTracksNegative}/${artist.distinctTracksAssessed} ` +
        `30d=${formatRate(artist.recent30dSkipRate)} ` +
        `90d=${formatRate(artist.recent90dSkipRate)} ` +
        `days=${artist.distinctNegativeDays}`,
    );
  }
  if (projection.artists.length === 0) console.log("  (none)");

  console.log("");
  console.log(
    "SHADOW READ-ONLY: nenhum perfil foi persistido, nenhum MusicPreferenceSignal foi criado e nenhuma playlist foi alterada.",
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    email: null,
    username: null,
    runIds: [],
    maxPages: undefined,
    windowHours: undefined,
    top: 20,
  };

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      args.email = arg.slice("--email=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--username=")) {
      args.username = arg.slice("--username=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--run-id=")) {
      const values = arg
        .slice("--run-id=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      args.runIds.push(...values);
      continue;
    }
    if (arg.startsWith("--max-pages=")) {
      args.maxPages = positiveNumber(
        arg.slice("--max-pages=".length),
        "--max-pages",
        true,
      );
      continue;
    }
    if (arg.startsWith("--window-hours=")) {
      args.windowHours = positiveNumber(
        arg.slice("--window-hours=".length),
        "--window-hours",
        false,
      );
      continue;
    }
    if (arg.startsWith("--top=")) {
      args.top = positiveNumber(arg.slice("--top=".length), "--top", true);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  args.runIds = [...new Set(args.runIds)];
  return args;
}

function positiveNumber(value: string, label: string, integer: boolean): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be a positive ${integer ? "integer" : "number"}`);
  }
  return parsed;
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
