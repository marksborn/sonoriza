import { prisma } from "@/lib/prisma";
import {
  buildMusic06NegativeProjectionShadowReport,
  previewMusic06PlannerInfluenceShadow,
  prismaFirstPartyPlaybackPreferenceStore,
  type Music06PlannerShadowCandidate,
} from "@/services/music-preference";

type Args = {
  email: string | null;
  username: string | null;
  generationRunIds: string[];
  maxPages: number | undefined;
  windowHours: number | undefined;
  top: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) throw new Error("--email=<Sonoriza user email> is required");
  if (args.generationRunIds.length === 0) {
    throw new Error("Use at least one --run-id=<GenerationRun id>");
  }

  const apiKey = process.env.LASTFM_API_KEY?.trim();
  const username = args.username ?? process.env.LASTFM_USERNAME?.trim() ?? null;
  if (!apiKey) throw new Error("Configure LASTFM_API_KEY before MUSIC-06 Gate 5 report");
  if (!username) {
    throw new Error("Use --username=<Last.fm user> or configure LASTFM_USERNAME");
  }

  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const asOf = new Date();
  const negative = await buildMusic06NegativeProjectionShadowReport({
    userId: user.id,
    generationRunIds: args.generationRunIds,
    username,
    apiKey,
    prismaClient: prisma,
    asOf,
    maxPages: args.maxPages,
    defaultWindowHours: args.windowHours,
  });

  // Gate 5 uses the last explicitly supplied run only as a representative,
  // first-party published-order sample. This is NOT the future planner pool.
  const sampleRunId = args.generationRunIds[args.generationRunIds.length - 1]!;
  const sampleReport = negative.sourceReports.find(
    (report) => report.coverage.generationRunId === sampleRunId,
  );
  if (!sampleReport) {
    throw new Error(`Gate 5 sample run not found in source reports: ${sampleRunId}`);
  }

  const candidates: Music06PlannerShadowCandidate[] = sampleReport.coverage.targets
    .flatMap((target) => target.assessment.matches)
    .map((match) => ({
      candidateKey: match.occurrence.generationItemId,
      type: "MUSIC" as const,
      trackName: match.occurrence.trackName,
      artistName: match.occurrence.artistName,
      spotifyTrackId: match.occurrence.spotifyTrackId,
      // The Gate 2 published-order contract does not currently carry artist id.
      // Actual planner candidates do; the pure Gate 5 bridge supports it there.
      primaryArtistId: null,
    }));

  const preferences = await prismaFirstPartyPlaybackPreferenceStore.list(user.id);
  const shadow = previewMusic06PlannerInfluenceShadow({
    candidates,
    projection: negative.projection,
    firstPartyPreferences: preferences,
  });

  console.log("========== MUSIC-06 GATE 5 — PLANNER INFLUENCE SHADOW ==========");
  console.log(`Mode:                         ${shadow.mode}`);
  console.log(`Policy version:               ${shadow.policyVersion}`);
  console.log(`Sonoriza user:                ${user.email ?? user.id}`);
  console.log(`Last.fm user:                 ${username}`);
  console.log(`Projection runs:              ${negative.generationRunIds.length}`);
  console.log(`Published-order sample run:   ${sampleRunId}`);
  console.log(`Sample music candidates:      ${shadow.musicCandidateCount}`);
  console.log(`Assessed occurrences:         ${negative.projection.assessedOccurrenceCount}`);
  console.log(`Negative occurrences:         ${negative.projection.negativeOccurrenceCount}`);
  console.log(`Recommendation capability:    ${shadow.capability.recommendationDecision}`);
  console.log(`Eligibility capability:       ${shadow.capability.plannerEligibilityDecision}`);
  console.log(`Productively authorized:      ${shadow.capability.productivelyAuthorized}`);
  console.log(`Influenced candidates:        ${shadow.influencedCandidateCount}`);
  console.log(`Track influences:             ${shadow.trackProjectionInfluenceCount}`);
  console.log(`Artist influences:            ${shadow.artistProjectionInfluenceCount}`);
  console.log(`Explicit preference suppress: ${shadow.explicitPreferenceSuppressedCount}`);
  console.log(`Max observed rank shift:      ${shadow.maxObservedMusicRankShift}`);

  const influenced = shadow.influences
    .filter((row) => row.requestedMusicRankShift > 0)
    .sort(
      (left, right) =>
        right.actualMusicRankShift - left.actualMusicRankShift ||
        (left.originalMusicRank ?? Number.MAX_SAFE_INTEGER) -
          (right.originalMusicRank ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, args.top);

  console.log("");
  console.log(`Influence sample (top ${args.top}):`);
  if (influenced.length === 0) {
    console.log("  (none)");
  } else {
    for (const row of influenced) {
      const candidate = candidates.find(
        (item) => item.candidateKey === row.candidateKey,
      );
      console.log(
        `  ${candidate?.artistName ?? "?"} — ${candidate?.trackName ?? "?"}: ` +
          `musicRank ${row.originalMusicRank} -> ${row.shadowMusicRank}; ` +
          `requested=${row.requestedMusicRankShift}; actual=${row.actualMusicRankShift}; ` +
          `reasons=${row.reasons.join("+") || "-"}`,
      );
    }
  }

  console.log("");
  console.log(
    "SHADOW READ-ONLY: a ordem acima é apenas hipotética; o planner produtivo não foi chamado nem alterado.",
  );
  if (!shadow.capability.productivelyAuthorized) {
    console.log(
      "CAPABILITY BLOCK: Last.fm continua REVIEW_REQUIRED para recommendation; nenhum bypass produtivo foi criado.",
    );
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    email: null,
    username: null,
    generationRunIds: [],
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
      const runId = arg.slice("--run-id=".length).trim();
      if (runId) args.generationRunIds.push(runId);
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

  args.generationRunIds = [...new Set(args.generationRunIds)];
  return args;
}

function positiveNumber(value: string, label: string, integer: boolean): number {
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
