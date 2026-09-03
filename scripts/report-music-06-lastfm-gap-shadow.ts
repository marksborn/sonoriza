import { prisma } from "@/lib/prisma";
import { buildMusic06LastFmGapShadowReport } from "@/services/music-preference/lastfm-gap-shadow-report";

type Args = {
  email: string | null;
  generationRunId: string | null;
  username: string | null;
  from: Date | undefined;
  to: Date | undefined;
  maxPages: number | undefined;
  windowHours: number | undefined;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) throw new Error("--email=<Sonoriza user email> is required");
  if (!args.generationRunId) throw new Error("--run-id=<GenerationRun id> is required");

  const apiKey = process.env.LASTFM_API_KEY?.trim();
  const username = args.username ?? process.env.LASTFM_USERNAME?.trim() ?? null;
  if (!apiKey) throw new Error("Configure LASTFM_API_KEY before MUSIC-06 Gate 3 report");
  if (!username) {
    throw new Error("Use --username=<Last.fm user> or configure LASTFM_USERNAME");
  }

  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const report = await buildMusic06LastFmGapShadowReport({
    userId: user.id,
    generationRunId: args.generationRunId,
    username,
    apiKey,
    prismaClient: prisma,
    from: args.from,
    to: args.to,
    maxPages: args.maxPages,
    defaultWindowHours: args.windowHours,
  });

  console.log("========== MUSIC-06 GATE 3 — LAST.FM GAP SHADOW ==========");
  console.log(`Mode:              ${report.mode}`);
  console.log(`Sonoriza user:     ${user.email ?? user.id}`);
  console.log(`Last.fm user:      ${report.coverage.username}`);
  console.log(`Generation run:    ${report.coverage.generationRunId}`);
  console.log(`Published at:      ${report.coverage.publishedAt.toISOString()}`);
  console.log(`Requested from:    ${report.coverage.requestedFrom.toISOString()}`);
  console.log(`Requested to:      ${report.coverage.requestedTo.toISOString()}`);
  console.log(`Provider:          ${report.coverage.providerStatus}`);
  console.log(`Assessed windows:  ${report.assessedWindowCount}`);
  console.log(`Inferred gaps:     ${report.inferredGapCount}`);

  for (const target of report.targets) {
    console.log("");
    console.log(`Target ${target.targetPlaylistId}`);
    console.log(`  coverage:         ${target.coverageStatus}`);
    console.log(`  assessed windows: ${target.shadow.assessedWindowCount}`);
    console.log(`  inferred gaps:    ${target.shadow.inferredGapCount}`);
    for (const gap of target.shadow.gaps) {
      console.log(
        `    #${gap.position} ${gap.artistName ?? "?"} — ${gap.trackName ?? "?"}`,
      );
      console.log(
        `      ${gap.previousPosition}@${gap.previousPlayedAt.toISOString()} -> ` +
          `${gap.position} -> ${gap.nextPosition}@${gap.nextPlayedAt.toISOString()}`,
      );
      console.log(
        `      method=${gap.evidenceMethod} confidence=${gap.confidence.toFixed(2)}`,
      );
    }
  }

  console.log("");
  console.log("SHADOW READ-ONLY: nenhum MusicPreferenceSignal foi criado e nenhuma playlist foi alterada.");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    email: null,
    generationRunId: null,
    username: null,
    from: undefined,
    to: undefined,
    maxPages: undefined,
    windowHours: undefined,
  };

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      args.email = arg.slice("--email=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--run-id=")) {
      args.generationRunId = arg.slice("--run-id=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--username=")) {
      args.username = arg.slice("--username=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--from=")) {
      args.from = parseDateArg(arg.slice("--from=".length), "--from");
      continue;
    }
    if (arg.startsWith("--to=")) {
      args.to = parseDateArg(arg.slice("--to=".length), "--to");
      continue;
    }
    if (arg.startsWith("--max-pages=")) {
      args.maxPages = parsePositiveNumber(
        arg.slice("--max-pages=".length),
        "--max-pages",
        true,
      );
      continue;
    }
    if (arg.startsWith("--window-hours=")) {
      args.windowHours = parsePositiveNumber(
        arg.slice("--window-hours=".length),
        "--window-hours",
        false,
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function parseDateArg(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be ISO-8601`);
  return parsed;
}

function parsePositiveNumber(
  value: string,
  label: string,
  integer: boolean,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be a positive ${integer ? "integer" : "number"}`);
  }
  return parsed;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
