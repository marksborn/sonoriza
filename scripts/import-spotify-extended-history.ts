import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  readSpotifyExtendedHistoryPackage,
  type SpotifyExtendedHistoryPackage,
} from "@/services/spotify-extended-history/parser";
import { buildSpotifyExtendedPersistencePlan } from "@/services/spotify-extended-history/persistence-plan";
import {
  AMBIGUOUS_MATCH_TOLERANCE_MS,
  reconcileSpotifyExtendedHistory,
  summarizeAbsoluteDeltas,
  type ExistingListeningEvent,
} from "@/services/spotify-extended-history/reconcile";

type Args = {
  file: string;
  email: string;
  samples: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("========== HISTORY-02 — SPOTIFY EXTENDED HISTORY ==========");
  console.log("Mode:                 DRY-RUN / READ-ONLY");
  console.log(`Package:              ${args.file}`);

  const parsed = await readSpotifyExtendedHistoryPackage(args.file);
  printPackageSummary(parsed);

  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

      const user = await tx.user.findUnique({
        where: { email: args.email },
        select: { id: true, email: true },
      });
      if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

      const lowerBound = parsed.musicEvents.reduce<Date | null>(
        (current, event) =>
          current === null || event.estimatedStartedAt < current ? event.estimatedStartedAt : current,
        null,
      );
      const upperBound = parsed.latestEndedAt;
      if (!lowerBound || !upperBound) throw new Error("Spotify package contains no valid music events");

      const from = new Date(lowerBound.getTime() - AMBIGUOUS_MATCH_TOLERANCE_MS);
      const to = new Date(upperBound.getTime() + AMBIGUOUS_MATCH_TOLERANCE_MS);

      // Raw SQL is deliberate here: a dry-run built from the HISTORY-02 branch
      // must be able to inspect a production database both before and after the
      // migration that adds SPOTIFY_EXTENDED_HISTORY to the Prisma enum.
      const existingEvents = await tx.$queryRaw<ExistingListeningEvent[]>(Prisma.sql`
        SELECT
          "id",
          "spotifyTrackId",
          "trackName",
          "artistName",
          "playedAt",
          "source"::text AS "source",
          "sourceEventKey",
          "metadata"
        FROM "TrackListeningEvent"
        WHERE "userId" = ${user.id}
          AND "playedAt" >= ${from}
          AND "playedAt" <= ${to}
          AND "source"::text IN (
            'LASTFM_SCROBBLE',
            'SPOTIFY_RECENTLY_PLAYED',
            'SPOTIFY_EXTENDED_HISTORY'
          )
      `);

      console.log("");
      console.log("========== CANONICAL HISTORY SNAPSHOT ==========");
      console.log(`Sonoriza user:         ${user.email ?? user.id}`);
      console.log(`Existing events read:  ${existingEvents.length}`);
      console.log(`Existing Last.fm:      ${existingEvents.filter((event) => event.source === "LASTFM_SCROBBLE").length}`);
      console.log(`Existing Recently:     ${existingEvents.filter((event) => event.source === "SPOTIFY_RECENTLY_PLAYED").length}`);
      console.log(`Existing Extended:     ${existingEvents.filter((event) => event.source === "SPOTIFY_EXTENDED_HISTORY").length}`);

      return reconcileSpotifyExtendedHistory(parsed.musicEvents, existingEvents);
    },
    { maxWait: 10_000, timeout: 120_000 },
  );

  const summary = result.summary;
  console.log("");
  console.log("========== RECONCILIATION ==========");
  console.log(`Unique music events:   ${summary.totalUniqueExportEvents}`);
  console.log(`EXACT Last.fm:         ${summary.exactExistingLastFm}`);
  console.log(`EXACT Recently Played: ${summary.exactExistingRecentlyPlayed}`);
  console.log(`EXACT Extended:        ${summary.exactExistingExtendedHistory}`);
  console.log(`NEW uncovered:         ${summary.newUncoveredEvents}`);
  console.log(`CONFLICT/ambiguous:    ${summary.conflictAmbiguous}`);
  console.log(`Enrichment candidates: ${summary.enrichmentCandidates}`);
  console.log(`Estimated inserts:     ${summary.estimatedInserts}`);

  printDeltaSummary("Last.fm start delta", summarizeAbsoluteDeltas(summary.lastFmMatchDeltaMs));
  printDeltaSummary("Recently start delta", summarizeAbsoluteDeltas(summary.recentlyPlayedMatchDeltaMs));

  console.log("");
  console.log("========== CONFLICT DIAGNOSTICS ==========");
  console.log(`MULTIPLE_CONFIDENT_LASTFM:  ${summary.conflictReasonCounts.MULTIPLE_CONFIDENT_LASTFM}`);
  console.log(`MULTIPLE_CONFIDENT_SPOTIFY: ${summary.conflictReasonCounts.MULTIPLE_CONFIDENT_SPOTIFY}`);
  console.log(`CONFIDENT_CROSS_SOURCE:     ${summary.conflictReasonCounts.CONFIDENT_CROSS_SOURCE}`);
  console.log(`NEAR_ONLY_LASTFM:           ${summary.conflictReasonCounts.NEAR_ONLY_LASTFM}`);
  console.log(`NEAR_ONLY_SPOTIFY:          ${summary.conflictReasonCounts.NEAR_ONLY_SPOTIFY}`);
  console.log(`NEAR_CROSS_SOURCE:          ${summary.conflictReasonCounts.NEAR_CROSS_SOURCE}`);
  console.log("Candidate count buckets:");
  console.log(`  1:                       ${summary.conflictCandidateCountBuckets.one}`);
  console.log(`  2:                       ${summary.conflictCandidateCountBuckets.two}`);
  console.log(`  3:                       ${summary.conflictCandidateCountBuckets.three}`);
  console.log(`  4:                       ${summary.conflictCandidateCountBuckets.four}`);
  console.log(`  5+:                      ${summary.conflictCandidateCountBuckets.fiveOrMore}`);
  printDeltaSummary("Conflict nearest delta", summarizeAbsoluteDeltas(summary.conflictNearestDeltaMs));

  const plan = buildSpotifyExtendedPersistencePlan(parsed.archiveSha256, result);
  console.log("");
  console.log("========== PERSISTENCE PLAN — FROZEN / READ-ONLY ==========");
  console.log(`Plan version:           ${plan.version}`);
  console.log(`Plan hash:              ${plan.planHash}`);
  console.log(`INSERT_NEW:             ${plan.summary.insertNew}`);
  console.log(`ENRICH_EXISTING:        ${plan.summary.enrichExisting}`);
  console.log(`QUARANTINE_CONFLICT:    ${plan.summary.quarantineConflict}`);
  console.log(`NOOP_ALREADY_ENRICHED:  ${plan.summary.noopAlreadyEnriched}`);
  console.log("Apply available:        NÃO");

  if (args.samples > 0) {
    console.log("");
    console.log("========== LOCAL DIAGNOSTIC SAMPLES ==========");
    const samples = result.entries
      .filter((entry) => entry.classification === "NEW_UNCOVERED_EVENT" || entry.classification === "CONFLICT_AMBIGUOUS")
      .slice(0, args.samples);
    for (const entry of samples) {
      console.log([
        entry.classification,
        entry.event.estimatedStartedAt.toISOString(),
        entry.event.artistName,
        entry.event.trackName,
        entry.event.spotifyTrackUri,
        `candidates=${entry.candidateCount}`,
        `reason=${entry.conflictReason ?? "n/a"}`,
        `nearest=${entry.nearestCandidateDeltaMs === null ? "n/a" : `${Math.round(entry.nearestCandidateDeltaMs / 1000)}s`}`,
      ].join(" | "));
    }
  }

  console.log("");
  console.log("DRY-RUN COMPLETE: nenhuma linha do banco foi alterada.");
  console.log("Nenhuma chamada ou escrita Spotify foi executada.");
  console.log("HISTORY-02 apply/import permanece bloqueado neste gate.");
}

function printPackageSummary(parsed: SpotifyExtendedHistoryPackage): void {
  console.log("");
  console.log("========== PACKAGE ==========");
  console.log(`SHA-256:              ${parsed.archiveSha256}`);
  console.log(`Archive bytes:        ${parsed.archiveBytes}`);
  console.log(`Audio JSON files:     ${parsed.audioFileCount}`);
  console.log(`Video JSON files:     ${parsed.videoFileCount}`);
  console.log(`Audio records:        ${parsed.audioRecordCount}`);
  console.log(`Video records:        ${parsed.videoRecordCount}`);
  console.log(`Music records:        ${parsed.musicRecordCount}`);
  console.log(`Unique music events:  ${parsed.uniqueMusicEventCount}`);
  console.log(`Duplicate groups:     ${parsed.duplicateMusicGroupCount}`);
  console.log(`Duplicate occurrences:${parsed.duplicateMusicOccurrenceCount}`);
  console.log(`Podcast records:      ${parsed.podcastRecordCount}`);
  console.log(`Audiobook records:    ${parsed.audiobookRecordCount}`);
  console.log(`Other audio records:  ${parsed.otherAudioRecordCount}`);
  console.log(`Invalid music records:${parsed.invalidMusicRecords.length}`);
  console.log(`First music stop:     ${parsed.earliestEndedAt?.toISOString() ?? "n/a"}`);
  console.log(`Last music stop:      ${parsed.latestEndedAt?.toISOString() ?? "n/a"}`);
}

function printDeltaSummary(
  label: string,
  summary: { count: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null },
): void {
  const format = (value: number | null) => value === null ? "n/a" : `${Math.round(value / 1000)}s`;
  console.log(`${label}: count=${summary.count} p50=${format(summary.p50Ms)} p95=${format(summary.p95Ms)} max=${format(summary.maxMs)}`);
}

function parseArgs(argv: string[]): Args {
  let file = "";
  let email = "";
  let samples = 0;

  for (const arg of argv) {
    if (arg === "--apply") {
      throw new Error("HISTORY-02 Gate 1 is dry-run only; --apply is intentionally unavailable");
    }
    if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length).trim();
      continue;
    }
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      continue;
    }
    if (arg.startsWith("--samples=")) {
      const parsed = Number(arg.slice("--samples=".length));
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        throw new Error("--samples must be an integer between 0 and 100");
      }
      samples = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!file) throw new Error("--file=<Spotify Extended History ZIP> is required");
  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return { file, email, samples };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
