import { prisma } from "@/lib/prisma";
import {
  applyMusic06PlannerInfluence,
  loadPublishedMusicRun,
  prepareMusic06PlannerRuntime,
  prismaFirstPartyPlaybackPreferenceStore,
} from "@/services/music-preference";

type Args = {
  email: string | null;
  username: string | null;
  top: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) throw new Error("--email=<Sonoriza user email> is required");

  const apiKey = process.env.LASTFM_API_KEY?.trim();
  const username = args.username ?? process.env.LASTFM_USERNAME?.trim() ?? null;
  if (!apiKey) throw new Error("Configure LASTFM_API_KEY before MUSIC-06 Gate 5B report");
  if (!username) {
    throw new Error("Use --username=<Last.fm user> or configure LASTFM_USERNAME");
  }

  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const asOf = new Date();
  const preparation = await prepareMusic06PlannerRuntime({
    userId: user.id,
    userEmail: user.email,
    asOf,
    prismaClient: prisma,
    apiKey,
    username,
    // Validation only: resolve exactly the capability/runtime that would be
    // active after explicit production enablement, without mutating .env.
    masterEnabled: "true",
    allowlistedEmails: user.email ?? "",
  });

  console.log("========== MUSIC-06 GATE 5B — PRODUCTIVE RUNTIME READ-ONLY ==========");
  console.log(`Sonoriza user:                  ${user.email ?? user.id}`);
  console.log(`Last.fm user:                   ${username}`);
  console.log(`As of:                          ${asOf.toISOString()}`);
  console.log(`Runtime status:                 ${preparation.status}`);
  console.log(`Policy enabled:                 ${preparation.policy.enabled}`);
  console.log(`Policy reason:                  ${preparation.policy.reason}`);
  console.log(`Baseline recommendation:        ${preparation.policy.capability.baselineRecommendationDecision}`);
  console.log(`Scoped bounded rerank:          ${preparation.policy.capability.boundedRerankDecision}`);
  console.log(`Baseline planner eligibility:   ${preparation.policy.capability.baselinePlannerEligibilityDecision}`);
  console.log(`Eligibility change allowed:     ${preparation.policy.capability.eligibilityChangeAllowed}`);
  console.log(`Approval scope:                 ${preparation.policy.capability.approval.scope}`);
  console.log(`Source runs selected:           ${preparation.sourceRunIds.length}`);
  console.log(`Confirmed targets selected:     ${preparation.selectedTargetCount}`);
  if (preparation.observation) {
    console.log(`Last.fm pages:                  ${preparation.observation.pagesFetched}/${preparation.observation.totalPages}`);
    console.log(`Last.fm scrobbles:              ${preparation.observation.scrobbleCount}`);
  }
  if (preparation.failure) console.log(`Preparation failure:            ${preparation.failure}`);

  const projection = preparation.projection;
  if (!projection) {
    console.log("");
    console.log("No productive projection is currently available; runtime would abstain.");
    console.log("READ-ONLY: no profile, preference, generation or Spotify write occurred.");
    return;
  }

  console.log("");
  console.log("Projection:");
  console.log(`  assessed occurrences:         ${projection.assessedOccurrenceCount}`);
  console.log(`  negative occurrences:         ${projection.negativeOccurrenceCount}`);
  console.log(`  duplicate occurrences:        ${projection.duplicateOccurrenceCount}`);
  console.log(`  conflicting occurrences:      ${projection.conflictingOccurrenceCount}`);
  console.log(`  unprojectable occurrences:    ${projection.unprojectableOccurrenceCount}`);
  console.log(`  track projections:            ${projection.tracks.length}`);
  console.log(`  artist projections:           ${projection.artists.length}`);

  const sampleRunId = preparation.sourceRunIds[0] ?? null;
  if (!sampleRunId) {
    console.log("");
    console.log("No representative published run is available for rerank preview.");
    return;
  }

  const published = await loadPublishedMusicRun(user.id, sampleRunId, prisma);
  const sampleCandidates = published.targets.flatMap((target) =>
    target.occurrences.map((occurrence) => ({
      candidateKey: occurrence.generationItemId,
      type: "MUSIC" as const,
      trackName: occurrence.trackName,
      artistName: occurrence.artistName,
      spotifyTrackId: occurrence.spotifyTrackId,
      primaryArtistId: null,
    })),
  );
  const preferences = await prismaFirstPartyPlaybackPreferenceStore.list(user.id);
  const preview = applyMusic06PlannerInfluence({
    candidates: sampleCandidates,
    projection,
    firstPartyPreferences: preferences,
    capability: preparation.policy.capability,
  });

  console.log("");
  console.log("Representative published-order preview:");
  console.log(`  sample run:                   ${sampleRunId}`);
  console.log(`  music candidates:             ${preview.musicCandidateCount}`);
  console.log(`  productive authorized:        ${preview.authorized}`);
  console.log(`  would apply rerank:           ${preview.applied}`);
  console.log(`  influenced candidates:        ${preview.influencedCandidateCount}`);
  console.log(`  track influences:             ${preview.trackProjectionInfluenceCount}`);
  console.log(`  artist influences:            ${preview.artistProjectionInfluenceCount}`);
  console.log(`  explicit preference suppress: ${preview.explicitPreferenceSuppressedCount}`);
  console.log(`  max music rank shift:         ${preview.maxObservedMusicRankShift}`);
  console.log(`  eligibility changed:          ${preview.eligibilityChanged}`);

  const influenced = preview.influences
    .filter((row) => row.actualMusicRankShift > 0)
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
    console.log("  (none — current evidence remains below productive thresholds for this sample)");
  } else {
    const candidateByKey = new Map(
      sampleCandidates.map((candidate) => [candidate.candidateKey, candidate] as const),
    );
    for (const row of influenced) {
      const candidate = candidateByKey.get(row.candidateKey);
      console.log(
        `  ${candidate?.artistName ?? "?"} — ${candidate?.trackName ?? "?"}: ` +
          `musicRank ${row.originalMusicRank} -> ${row.shadowMusicRank}; ` +
          `shift=${row.actualMusicRankShift}; reasons=${row.reasons.join("+") || "-"}`,
      );
    }
  }

  console.log("");
  console.log(
    "READ-ONLY: feature policy was resolved in-process only; no .env, profile, preference, generation or Spotify write occurred.",
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = { email: null, username: null, top: 20 };
  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      args.email = arg.slice("--email=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--username=")) {
      args.username = arg.slice("--username=".length).trim() || null;
      continue;
    }
    if (arg.startsWith("--top=")) {
      const value = Number(arg.slice("--top=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--top must be a positive integer");
      }
      args.top = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
