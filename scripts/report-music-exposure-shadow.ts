import { prisma } from "@/lib/prisma";
import { LastFmClient } from "@/services/lastfm/client";
import {
  buildMusicExposureShadow,
  MUSIC_07_SHADOW_THRESHOLD_DEFAULT,
  type MusicExposureShadowPublication,
  type MusicExposureShadowUpdatePolicy,
} from "@/services/music-exposure/shadow";
import { readLastFmRecentObservation } from "@/services/music-preference/lastfm-coverage-reader";

type Args = {
  email: string;
  threshold: number;
  maxPages: number;
  from: Date | null;
  to: Date;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Gate 2 production probe safety: every database read happens through one
  // explicit PostgreSQL READ ONLY transaction. Last.fm is queried only after
  // the database snapshot has been released.
  const snapshot = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

      const readOnly = await tx.$queryRaw<Array<{ read_only: string }>>`
        SELECT current_setting('transaction_read_only') AS read_only
      `;
      if (readOnly[0]?.read_only !== "on") {
        throw new Error("MUSIC-07 Gate 2 refused to run without READ ONLY transaction");
      }

      const user = await tx.user.findUnique({
        where: { email: args.email },
        select: { id: true, email: true },
      });
      if (!user) throw new Error(`Sonoriza user not found: ${args.email}`);

      const runs = await tx.generationRun.findMany({
        where: {
          userId: user.id,
          simulation: false,
          status: { in: ["SUCCESS", "PARTIAL"] },
          startedAt: {
            ...(args.from ? { gte: args.from } : {}),
            lte: args.to,
          },
        },
        orderBy: { startedAt: "asc" },
        select: {
          id: true,
          status: true,
          simulation: true,
          startedAt: true,
          finishedAt: true,
          summary: true,
          items: {
            where: {
              contentType: "MUSIC",
              spotifyTrackId: { not: null },
              title: { not: null },
              subtitle: { not: null },
            },
            orderBy: [{ targetPlaylistId: "asc" }, { position: "asc" }],
            select: {
              targetPlaylistId: true,
              position: true,
              spotifyTrackId: true,
              title: true,
              subtitle: true,
              target: {
                select: {
                  name: true,
                  updatePolicy: true,
                },
              },
            },
          },
        },
      });

      return { user, runs, transactionReadOnly: readOnly[0]?.read_only ?? "unknown" };
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: 10_000,
      timeout: 30_000,
    },
  );

  const { user, runs } = snapshot;
  const publications: MusicExposureShadowPublication[] = [];
  let missingApplyProofCount = 0;
  let identityReadyItemCount = 0;
  let unappliedKeepFilledSnapshotCount = 0;

  for (const run of runs) {
    const byTarget = new Map<string, typeof run.items>();
    for (const item of run.items) {
      const rows = byTarget.get(item.targetPlaylistId);
      if (rows) rows.push(item);
      else byTarget.set(item.targetPlaylistId, [item]);
    }

    for (const [targetPlaylistId, items] of byTarget) {
      identityReadyItemCount += items.length;
      const first = items[0]!;
      const updatePolicy = first.target.updatePolicy as MusicExposureShadowUpdatePolicy;
      const applyProof = targetAppliedFromSummary(run.summary, targetPlaylistId);
      if (applyProof === null) {
        missingApplyProofCount += 1;
        continue;
      }
      if (!applyProof && updatePolicy !== "KEEP_FILLED") continue;
      if (!applyProof && updatePolicy === "KEEP_FILLED") {
        unappliedKeepFilledSnapshotCount += 1;
      }

      const publishedAt = run.finishedAt ?? run.startedAt;
      if (publishedAt > args.to) continue;

      publications.push({
        runId: run.id,
        targetPlaylistId,
        targetName: first.target.name,
        updatePolicy,
        publishedAt,
        simulation: run.simulation,
        status: run.status,
        applied: applyProof,
        tracks: items.flatMap((item) => {
          const spotifyTrackId = item.spotifyTrackId?.trim();
          const trackName = item.title?.trim();
          const artistName = item.subtitle?.trim();
          if (!spotifyTrackId || !trackName || !artistName) return [];
          return [
            {
              trackKey: `spotify:${spotifyTrackId}`,
              trackName,
              artistName,
              position: item.position,
            },
          ];
        }),
      });
    }
  }

  const earliestPublication = publications.reduce<Date | null>(
    (earliest, publication) =>
      earliest === null || publication.publishedAt < earliest
        ? publication.publishedAt
        : earliest,
    null,
  );

  let scrobbles: Array<{
    playedAt: Date;
    trackName: string;
    artistName: string;
  }> = [];
  let lastFmStatus = "NOT_QUERIED_NO_PUBLICATIONS";
  let lastFmPages = 0;
  let lastFmTotalPages = 0;
  let lastFmComplete = false;

  if (earliestPublication) {
    const apiKey = process.env.LASTFM_API_KEY?.trim();
    const username = process.env.LASTFM_USERNAME?.trim();
    if (!apiKey || !username) {
      lastFmStatus = "UNAVAILABLE_MISSING_ENV";
    } else {
      const client = new LastFmClient({ apiKey });
      const observation = await readLastFmRecentObservation({
        client,
        username,
        from: new Date(Math.max(0, earliestPublication.getTime() - 60_000)),
        to: args.to,
        maxPages: args.maxPages,
      });
      scrobbles = observation.scrobbles.map((row) => ({
        playedAt: row.playedAt,
        trackName: row.trackName,
        artistName: row.artistName,
      }));
      lastFmPages = observation.pagesFetched;
      lastFmTotalPages = observation.totalPages;
      lastFmComplete = observation.complete;
      lastFmStatus = observation.complete ? "COMPLETE" : "PARTIAL_BOUNDED";
    }
  }

  const report = buildMusicExposureShadow({
    publications,
    scrobbles,
    observedUntil: args.to,
    threshold: args.threshold,
  });

  console.log("========== MUSIC-07 GATE 2 — EXPOSURE SHADOW ==========");
  console.log(`User:                         ${user.email ?? user.id}`);
  console.log("Mode:                         READ-ONLY REPORT");
  console.log(`Database transaction:         READ ONLY (${snapshot.transactionReadOnly})`);
  console.log("Planner influence:            NONE");
  console.log("Spotify API calls:            NONE");
  console.log("Database writes:              NONE");
  console.log(`Threshold shadow:             N=${report.threshold}`);
  console.log(`Report until:                 ${args.to.toISOString()}`);
  console.log(
    `Requested from:              ${args.from?.toISOString() ?? "auto: all identity-ready post-purge rows"}`,
  );
  console.log("");
  console.log("---------- INPUT / PROVENANCE ----------");
  console.log(`Real SUCCESS/PARTIAL runs:    ${runs.length}`);
  console.log(`Identity-ready GenerationItem:${identityReadyItemCount}`);
  console.log(`Measurable target snapshots:  ${publications.length}`);
  console.log(
    `Applied target publications:  ${publications.filter((row) => row.applied).length}`,
  );
  console.log(`KEEP_FILLED no-op baselines:  ${unappliedKeepFilledSnapshotCount}`);
  console.log(`Missing apply proof skipped:  ${missingApplyProofCount}`);
  console.log(`Last.fm status:               ${lastFmStatus}`);
  console.log(`Last.fm pages:                ${lastFmPages}/${lastFmTotalPages}`);
  console.log(`Last.fm complete:             ${lastFmComplete}`);
  console.log(`Last.fm scrobbles observed:   ${scrobbles.length}`);
  console.log("");
  console.log("---------- SHADOW RESULT ----------");
  console.log(`Measurable publications:      ${report.publicationCount}`);
  console.log(`Exposure events:              ${report.exposureCount}`);
  console.log(`Valid exposures:              ${report.validExposureCount}`);
  console.log(`Confirmed consumptions:       ${report.confirmedConsumptionCount}`);
  console.log(`Usage-unconfirmed exposures:  ${report.sessionUsageUnconfirmedCount}`);
  console.log(`KEEP_FILLED baseline skipped: ${report.keepFilledBaselineSkippedCount}`);
  console.log(`Unique exposed tracks:        ${report.uniqueExposedTrackCount}`);
  console.log(`Would reach N=${report.threshold}:          ${report.thresholdTrackCount}`);
  console.log("");
  console.log("---------- TARGETS ----------");
  if (report.targets.length === 0) console.log("(no measurable target publication yet)");
  for (const target of report.targets) {
    console.log(
      `${target.targetName}: snapshots=${target.publicationCount} valid=${target.validExposureCount} consumed=${target.confirmedConsumptionCount} usageUnknown=${target.sessionUsageUnconfirmedCount} keepFilledBaselineSkipped=${target.keepFilledBaselineSkippedCount}`,
    );
  }
  console.log("");
  console.log(`---------- TOP SHADOW COOLDOWN CANDIDATES (N=${report.threshold}) ----------`);
  const candidates = report.projections.filter((row) => row.wouldEnterCooldown).slice(0, 30);
  if (candidates.length === 0) console.log("(none)");
  for (const row of candidates) {
    console.log(
      `${row.consecutiveUnconfirmedExposureCount}x | ${row.artistName} — ${row.trackName} | last=${row.lastExposureAt?.toISOString() ?? "unknown"}`,
    );
  }
  console.log("");
  console.log("IMPORTANT:");
  console.log("- wouldEnterCooldown is SHADOW ONLY; no eligibility state is written.");
  console.log("- exposure never creates INFERRED_SKIP/INFERRED_IGNORED.");
  console.log("- absence of Last.fm evidence is UNKNOWN, never negative.");
  console.log("- KEEP_FILLED first measurable snapshot is baseline-only to avoid double counting.");
  console.log("========================================================");
}

function targetAppliedFromSummary(
  summary: unknown,
  targetPlaylistId: string,
): boolean | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const targets = (summary as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return null;
  for (const raw of targets) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row.targetPlaylistId !== targetPlaylistId) continue;
    return typeof row.applied === "boolean" ? row.applied : null;
  }
  return null;
}

function parseArgs(argv: string[]): Args {
  let email = process.env.MUSIC_07_SHADOW_EMAIL?.trim() || "";
  let threshold = MUSIC_07_SHADOW_THRESHOLD_DEFAULT;
  let maxPages = 10;
  let from: Date | null = null;
  let to = new Date();

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      continue;
    }
    if (arg.startsWith("--threshold=")) {
      threshold = parsePositiveInt(arg.slice("--threshold=".length), "--threshold");
      continue;
    }
    if (arg.startsWith("--max-pages=")) {
      maxPages = parsePositiveInt(arg.slice("--max-pages=".length), "--max-pages");
      continue;
    }
    if (arg.startsWith("--from=")) {
      from = parseDate(arg.slice("--from=".length), "--from");
      continue;
    }
    if (arg.startsWith("--to=")) {
      to = parseDate(arg.slice("--to=".length), "--to");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) {
    throw new Error("MUSIC-07 Gate 2 requires --email=<Sonoriza user email>");
  }
  if (from && from >= to) throw new Error("MUSIC-07 Gate 2 requires --from < --to");
  return { email, threshold, maxPages, from, to };
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseDate(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid date`);
  return parsed;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
