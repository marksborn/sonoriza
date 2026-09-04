import { prisma } from "@/lib/prisma";
import { buildMusic06LastFmCoverageShadowReport } from "@/services/music-preference/lastfm-coverage-shadow";

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
  if (!apiKey) throw new Error("Configure LASTFM_API_KEY before MUSIC-06 Gate 2 report");
  if (!username) {
    throw new Error("Use --username=<Last.fm user> or configure LASTFM_USERNAME");
  }

  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const report = await buildMusic06LastFmCoverageShadowReport({
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

  console.log("========== MUSIC-06 GATE 2 — LAST.FM COVERAGE SHADOW ==========");
  console.log(`Mode:              ${report.mode}`);
  console.log(`Sonoriza user:     ${user.email ?? user.id}`);
  console.log(`Last.fm user:      ${report.username}`);
  console.log(`Generation run:    ${report.generationRunId}`);
  console.log(`Published at:      ${report.publishedAt.toISOString()}`);
  console.log(`Requested from:    ${report.requestedFrom.toISOString()}`);
  console.log(`Requested to:      ${report.requestedTo.toISOString()}`);
  console.log(`Provider:          ${report.providerStatus}`);
  if (report.providerError) console.log(`Provider error:    ${report.providerError}`);
  if (report.observation) {
    console.log(`Pages:             ${report.observation.pagesFetched}/${report.observation.totalPages}`);
    console.log(`Pagination full:   ${report.observation.complete}`);
    console.log(`Scrobbles:         ${report.observation.scrobbles.length}`);
    console.log(`Now-playing seen:  ${report.observation.nowPlayingCount}`);
    console.log(`Invalid rows:      ${report.observation.invalidCount}`);
  }

  console.log("");
  for (const target of report.targets) {
    const assessment = target.assessment;
    console.log(`Target ${target.targetPlaylistId}`);
    console.log(`  coverage:         ${assessment.status}`);
    console.log(`  reasons:          ${assessment.reasons.join(", ") || "-"}`);
    console.log(`  published:        ${assessment.publishedOccurrenceCount}`);
    console.log(`  matched:          ${assessment.matchedOccurrenceCount}`);
    console.log(`  unmatched:        ${assessment.unmatchedOccurrenceCount}`);
    console.log(`  ambiguous:        ${assessment.ambiguousOccurrenceCount}`);
    console.log(`  unmatchable:      ${assessment.unmatchableOccurrenceCount}`);
    console.log(`  evaluable windows:${assessment.evaluableWindowCount}`);
    for (const window of assessment.windows) {
      console.log(
        `    ${window.previousPosition} -> ${window.centerPosition} -> ${window.nextPosition}: ` +
          `${window.evaluable ? "EVALUABLE" : "ABSTAIN"}` +
          `${window.reasons.length ? ` (${window.reasons.join(", ")})` : ""}`,
      );
    }
  }

  console.log("");
  console.log("READ-ONLY: nenhum INFERRED_SKIP foi criado e nenhuma playlist foi alterada.");
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
